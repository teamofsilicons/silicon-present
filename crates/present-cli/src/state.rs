//! Local state under `{home}/.present/`.
//!
//! - `{home}` is `$SILICON_HOME`, then `$HOME`, then Windows' `$USERPROFILE`. `present config home <dir>` writes
//!   a pointer file (`{default home}/.present/home`) that moves it elsewhere.
//! - The directory is mode 0700 and every file in it 0600 (Unix).
//! - `state.json` is replaced atomically (temporary file, fsync, rename).
//! - `state.lock` is held only around read-modify-write and around a token refresh, never
//!   while waiting for a Carbon to approve a device sign-in.
//! - Reading never creates anything, so `present accounts --json` and `present --help` leave a
//!   clean home untouched.

use crate::fail::{Fail, R};
use serde::{Deserialize, Serialize};
use silicon_present_client::Secret;
use silicon_present_client::accounts::SignedInAccount;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// One saved sign-in: Present's tokens for one account.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredSignIn {
    /// The Silicon Accounts origin that issued the tokens.
    pub accounts_url: String,
    /// `present`.
    pub app_id: String,
    /// Access token (30 minutes).
    pub access_token: Secret,
    /// Rotating refresh token.
    pub refresh_token: Secret,
    /// Access token expiry, Unix seconds.
    pub expires_at: i64,
    /// When the sign-in itself ends.
    #[serde(default)]
    pub refresh_expires_at: Option<i64>,
    /// Granted scopes.
    #[serde(default)]
    pub scope: String,
    /// Who signed in.
    pub account: SignedInAccount,
    /// `slt` (a Silicon's short-lived token) or `device` (a Carbon approved a code).
    pub method: String,
    /// When this sign-in was made.
    pub signed_in_at: i64,
}

/// The presentation this CLI last started, so `present next` needs no id.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredPresentation {
    /// Presentation id.
    pub id: String,
    /// Deck id.
    pub deck: String,
    /// Follow link.
    #[serde(default)]
    pub follow_url: String,
}

/// Everything in `state.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct State {
    /// Schema version.
    #[serde(default)]
    pub version: u32,
    /// Saved API URL (`present config api-url`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    /// Saved Silicon Accounts URL (`present config accounts-url`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts_url: Option<String>,
    /// Sign-ins by Silicon Accounts origin.
    #[serde(default)]
    pub sign_ins: BTreeMap<String, StoredSignIn>,
    /// The last presentation started from here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<StoredPresentation>,
}

/// Where state lives.
#[derive(Clone, Debug)]
pub struct Home {
    /// `{home}`.
    pub home: PathBuf,
    /// `{home}/.present`.
    pub dir: PathBuf,
    /// Why this home: `SILICON_HOME`, `HOME`, `USERPROFILE`, or the pointer file.
    pub source: String,
}

fn default_home() -> R<(PathBuf, String)> {
    if let Some(h) = std::env::var_os("SILICON_HOME").filter(|v| !v.is_empty()) {
        return Ok((PathBuf::from(h), "SILICON_HOME".into()));
    }
    if let Some(h) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return Ok((PathBuf::from(h), "HOME".into()));
    }
    if let Some(h) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
        return Ok((PathBuf::from(h), "USERPROFILE".into()));
    }
    Err(Fail::new(
        "no_home",
        "SILICON_HOME, HOME and USERPROFILE are unset, so there is nowhere to keep the sign-in.",
        "Set SILICON_HOME to a directory, or restore your normal HOME or Windows USERPROFILE setting.",
    ))
}

impl Home {
    /// Finds the home: the pointer file under the default home wins, then the default.
    pub fn locate() -> R<Self> {
        let (home, source) = default_home()?;
        let pointer = home.join(".present").join("home");
        if let Ok(text) = std::fs::read_to_string(&pointer) {
            let target = PathBuf::from(text.trim());
            if !text.trim().is_empty() {
                return Ok(Self {
                    dir: target.join(".present"),
                    home: target,
                    source: format!("{} (set with `present config home`)", pointer.display()),
                });
            }
        }
        Ok(Self {
            dir: home.join(".present"),
            home,
            source,
        })
    }

    /// Points the home somewhere else (`present config home <dir>`).
    pub fn set_pointer(dir: &Path) -> R<PathBuf> {
        if !dir.is_dir() {
            return Err(Fail::new(
                "not_a_directory",
                format!("{} is not a directory.", dir.display()),
                "Create it first (mkdir -p) or pick an existing directory.",
            ));
        }
        let target = dir
            .canonicalize()
            .map_err(|e| Fail::io(&format!("resolve {}", dir.display()), &e))?;
        let (home, _) = default_home()?;
        let pdir = home.join(".present");
        ensure_dir(&pdir)?;
        let pointer = pdir.join("home");
        if target == home {
            let _ = std::fs::remove_file(&pointer);
        } else {
            write_atomic(&pointer, target.display().to_string().as_bytes())?;
        }
        Ok(target)
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("state.json")
    }

    /// Reads state; a missing file is empty state.
    pub fn read(&self) -> R<State> {
        match std::fs::read(self.state_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
                Fail::new(
                    "state_unreadable",
                    format!("{} is not valid state ({e}).", self.state_path().display()),
                    "Move it aside and sign in again with `present login`.",
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(Fail::io(&format!("read {}", self.state_path().display()), &e)),
        }
    }

    /// Reads, changes and writes state under the lock.
    pub fn update<T>(&self, f: impl FnOnce(&mut State) -> T) -> R<T> {
        ensure_dir(&self.dir)?;
        let _lock = self.lock()?;
        let mut state = self.read()?;
        let out = f(&mut state);
        state.version = 1;
        let bytes = serde_json::to_vec_pretty(&state).map_err(|e| Fail::new("state_unwritable", e.to_string(), ""))?;
        write_atomic(&self.state_path(), &bytes)?;
        Ok(out)
    }

    /// Takes `state.lock` (exclusive), released on drop.
    pub fn lock(&self) -> R<File> {
        ensure_dir(&self.dir)?;
        let path = self.dir.join("state.lock");
        let f = open_private(&path, false)?;
        f.lock().map_err(|e| Fail::io(&format!("lock {}", path.display()), &e))?;
        Ok(f)
    }
}

fn ensure_dir(dir: &Path) -> R<()> {
    std::fs::create_dir_all(dir).map_err(|e| Fail::io(&format!("create {}", dir.display()), &e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn open_private(path: &Path, truncate: bool) -> R<File> {
    let mut o = OpenOptions::new();
    o.create(true).write(true).read(true).truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        o.mode(0o600);
    }
    o.open(path).map_err(|e| Fail::io(&format!("open {}", path.display()), &e))
}

/// Writes a file atomically with mode 0600.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> R<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = open_private(&tmp, true)?;
        f.write_all(bytes).map_err(|e| Fail::io(&format!("write {}", tmp.display()), &e))?;
        f.sync_all().map_err(|e| Fail::io(&format!("sync {}", tmp.display()), &e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| Fail::io(&format!("replace {}", path.display()), &e))
}
