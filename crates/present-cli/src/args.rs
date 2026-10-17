//! The command tree. Every command says what it is for, how it is used with others, its flags
//! and an example, so `present <command> --help` is enough to find your way.

use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

const TOP_AFTER: &str = "\
Start here:
  silicon-accounts login --app present -q | present login --slt-stdin    sign in (Silicons)
  present login                                                         sign in (Carbons, device code)
  present docs getting-started                                          the whole tour, bundled

Common workflows:
  Make a deck      present new \"Q4 review\" → present slide add <deck> --layout title --title \"Q4\" → present add text ...
  Look at it       present read <deck> → present render <deck> 1 -o s1.png
  Work in files    present pull <deck> q4/ → edit q4/slides/*/slide.json, *.html → present status q4/ → present push q4/
  Review           present comments <deck> → present reply <thread> \"Done\" → present resolve <thread>
  Share            present share <deck> c:ada --role commenter → present public <deck> view
  Go back          present versions <deck> → present compare <deck> 12 20 → present restore <deck> 12
  Present          present start <deck> → present next → present stop   (followers: present follow <presentation>)
  Follow along     present watch <deck> --json   (one JSON line per change, comment and presence)

Decks are named by id (dk7Hq2mP9xRt), a link to them, or their exact title.
Slides by number (1 = first) or id (s_ab12cd). Elements by id (e_ab12cd), z position (1 = back) or kind:n (text:2).
Every command that prints data takes --json. Errors say what, why and what to do (with --json, as {\"error\":{...}}).

Docs: present docs [topic]   ·   Rust package: silicon-present-client   ·   Repo: https://github.com/teamofsilicons/silicon-present";

/// Silicon Present: slides that Carbons and Silicons make, present and comment on together.
#[derive(Debug, Parser)]
#[command(
    name = "present",
    version,
    about = "Silicon Present: slides that Carbons and Silicons make, present and comment on together.",
    long_about = "Silicon Present: slides that Carbons and Silicons make, present and comment on together.\n\nThe present CLI can do everything the web editor at present.teamofsilicons.com can: make decks, read them as text, render slides to images, edit any slide or element, work on a deck as a folder of files, comment, share, go back through versions, export to any format and present live.",
    after_help = TOP_AFTER,
    disable_help_subcommand = true
)]
pub struct Cli {
    /// Print machine-readable JSON (errors too, as {"error":{code,message,hint}}).
    #[arg(long, global = true)]
    pub json: bool,
    /// The Silicon Present API (default https://present.teamofsilicons.com/api; locally the service itself, e.g. http://127.0.0.1:4321).
    #[arg(long, global = true, env = "PRESENT_API_URL", value_name = "URL")]
    pub api_url: Option<String>,
    /// The Silicon Accounts origin used to sign in (default https://accounts.teamofsilicons.com).
    #[arg(long, global = true, env = "ACCOUNTS_URL", value_name = "URL")]
    pub accounts_url: Option<String>,
    /// The command.
    #[command(subcommand)]
    pub command: Command,
}

/// A deck as `<deck>`: id, link or exact title.
pub type DeckRef = String;

/// Top-level commands.
#[derive(Debug, Subcommand)]
pub enum Command {
    // ---- signing in ---------------------------------------------------------------------
    /// Sign in with Silicon Accounts: a short-lived token (Silicons) or a device code (Carbons).
    #[command(
        args_conflicts_with_subcommands = true,
        long_about = "Sign in with Silicon Accounts.\n\nSilicons pass a short-lived token (slt_…, single use, 2 minutes) minted with `silicon-accounts login --app present -q`: pipe it in with --slt-stdin, or give it with --slt or as the only argument. Carbons run `present login` with no token: it shows a code to approve on the account site from any device.\n\nThe sign-in is saved in {home}/.present/state.json ({home} = $SILICON_HOME, else $HOME) and refreshed by itself.",
        after_help = "Examples:\n  silicon-accounts login --app present -q | present login --slt-stdin\n  present login --slt slt_3kd8…\n  present login              # Carbons: approve the code it shows\n  present login status --json\n\nThen: present whoami, present list"
    )]
    Login(LoginArgs),
    /// Sign out here and at Silicon Accounts.
    #[command(after_help = "Example: present logout\nSign in again with `present login`.")]
    Logout,
    /// How this CLI signs in (no network): app id, URLs, which sign-ins are on.
    #[command(after_help = "Example: present accounts --json\n→ {\"app_id\":\"present\",\"accounts_url\":…,\"sign_in\":{\"silicon\":…,\"carbon\":…}}")]
    Accounts,
    /// Who you are signed in as, as Silicon Present sees you.
    #[command(after_help = "Example: present whoami --json")]
    Whoami,
    /// Settings: where state lives and which service to talk to.
    #[command(subcommand, after_help = "Examples:\n  present config show\n  present config home /srv/silicons/designer\n  present config api-url http://127.0.0.1:4321")]
    Config(ConfigCmd),
    /// The bundled docs: getting started, every workflow, deck JSON, ops, folders.
    #[command(after_help = "Examples:\n  present docs                     # list topics\n  present docs getting-started\n  present docs ops")]
    Docs {
        /// The topic (leave out to list them).
        topic: Option<String>,
    },

    // ---- decks ------------------------------------------------------------------------
    /// List your decks (or the ones shared with you, or the trash).
    #[command(after_help = "Examples:\n  present list\n  present list --shared --json\n  present list --trash\n  present list --folder fd8Kq2mP9xRt\n\nThen: present read <deck>, present pull <deck>")]
    List {
        /// Decks and folders shared with you.
        #[arg(long, conflicts_with = "trash")]
        shared: bool,
        /// Your trash.
        #[arg(long)]
        trash: bool,
        /// Only decks in this folder.
        #[arg(long)]
        folder: Option<String>,
    },
    /// Make a new deck, empty or from another deck at a version.
    #[command(after_help = "Examples:\n  present new \"Q4 review\"\n  present new \"Q4 for the client\" --from dk7Hq2mP9xRt@42\n  present new \"Draft\" --folder fd8Kq2mP9xRt --json\n\nThen: present slide add <deck> --layout title --title \"Q4\"")]
    New {
        /// Title.
        title: String,
        /// Create it in this folder (yours, or one shared with you as editor).
        #[arg(long)]
        folder: Option<String>,
        /// Start from another deck, optionally at a version: <deck>@<version>.
        #[arg(long, value_name = "DECK[@VERSION]")]
        from: Option<String>,
    },
    /// Open a file (pptx, ppt, key, odp, pdf, html, image, video, audio) as a new deck, or on top of one.
    #[command(after_help = "Examples:\n  present open board.pptx\n  present open slides.pdf --folder fd8Kq2mP9xRt\n  present open v2.pptx --into dk7Hq2mP9xRt     # becomes the deck's next version\n\nGoogle Slides: download it as .pptx first.")]
    Open {
        /// The file.
        file: PathBuf,
        /// Open it on top of this deck as its next version instead of making a new deck.
        #[arg(long, value_name = "DECK")]
        into: Option<DeckRef>,
        /// Put the new deck in this folder.
        #[arg(long, conflicts_with = "into")]
        folder: Option<String>,
    },
    /// Rename a deck.
    #[command(after_help = "Example: present rename dk7Hq2mP9xRt \"Q4 review (final)\"")]
    Rename {
        /// The deck.
        deck: DeckRef,
        /// The new title.
        title: String,
    },
    /// Move a deck into a folder (or `root` for none).
    #[command(name = "move", after_help = "Examples:\n  present move dk7Hq2mP9xRt fd8Kq2mP9xRt\n  present move dk7Hq2mP9xRt root")]
    Move {
        /// The deck.
        deck: DeckRef,
        /// Folder id, or `root`.
        folder: String,
    },
    /// Put a deck in the trash (with its whole history; `untrash` brings it back).
    #[command(after_help = "Example: present trash dk7Hq2mP9xRt\nThen: present list --trash, present untrash <deck>")]
    Trash {
        /// The deck.
        deck: DeckRef,
    },
    /// Bring a deck back from the trash.
    #[command(after_help = "Example: present untrash dk7Hq2mP9xRt")]
    Untrash {
        /// The deck.
        deck: DeckRef,
    },
    /// Delete an element from a slide, or (with --permanent) a trashed deck for good.
    #[command(
        long_about = "Two uses:\n\n  present delete <deck> <slide> <element>   delete an element from a slide\n  present delete <deck> --permanent         delete a deck in the trash for good\n\nPermanent deletion is the only way anything is ever truly gone. It asks you to type the deck's title, unless --confirm <title> is given (needed when there is no terminal).",
        after_help = "Examples:\n  present delete dk7Hq2mP9xRt 2 e_ab12cd\n  present trash dk7Hq2mP9xRt && present delete dk7Hq2mP9xRt --permanent --confirm \"Old draft\""
    )]
    Delete {
        /// The deck.
        deck: DeckRef,
        /// The slide (to delete an element).
        slide: Option<String>,
        /// The element (to delete an element).
        element: Option<String>,
        /// Delete the deck itself for good (it must be in the trash).
        #[arg(long)]
        permanent: bool,
        /// The deck's exact title, to confirm without a prompt.
        #[arg(long, value_name = "TITLE")]
        confirm: Option<String>,
    },
    /// Offer a deck (or with --folder, a folder) to another Carbon or Silicon; they must accept.
    #[command(after_help = "Examples:\n  present transfer dk7Hq2mP9xRt c:ada\n  present transfer fd8Kq2mP9xRt si:writer --folder\n\nThe receiver runs: present transfers, then present transfers accept <id>")]
    Transfer {
        /// The deck (or folder with --folder).
        target: String,
        /// Who gets it: c:id or si:id.
        to: String,
        /// The target is a folder.
        #[arg(long)]
        folder: bool,
    },
    /// Transfers offered to you and by you; accept, decline or cancel one.
    #[command(after_help = "Examples:\n  present transfers\n  present transfers accept tr8Kq2mP9xRt\n  present transfers cancel tr8Kq2mP9xRt")]
    Transfers {
        /// accept, decline or cancel.
        action: Option<TransferAction>,
        /// The transfer id.
        id: Option<String>,
    },
    /// Folders: list, make, rename, move, trash, share.
    #[command(subcommand, after_help = "Examples:\n  present folder new \"Clients\"\n  present folder list --json\n  present folder share fd8Kq2mP9xRt c:ada --role editor")]
    Folder(FolderCmd),

    // ---- reading and seeing -------------------------------------------------------------
    /// Read a deck as text: every slide, element, position, the notes, and with --comments the threads next to what they're on.
    #[command(after_help = "Examples:\n  present read dk7Hq2mP9xRt\n  present read dk7Hq2mP9xRt --comments\n  present read dk7Hq2mP9xRt --version 12\n  present read dk7Hq2mP9xRt --json     # the deck JSON\n\nThen: present render <deck> <slide>, present set/replace/add ...")]
    Read {
        /// The deck.
        deck: DeckRef,
        /// Read it as it was at this version.
        #[arg(long)]
        version: Option<u64>,
        /// Show comment threads next to what they are on.
        #[arg(long)]
        comments: bool,
    },
    /// One slide (as JSON with --json), or change slides: add, move, delete, skip, section, notes, transition, background, layout.
    #[command(
        args_conflicts_with_subcommands = true,
        subcommand_negates_reqs = true,
        after_help = "Examples:\n  present slide dk7Hq2mP9xRt 3\n  present slide dk7Hq2mP9xRt s_ab12cd --json\n  present slide add dk7Hq2mP9xRt --layout title-body --title \"Plan\" --body $'One\\nTwo'\n  present slide notes dk7Hq2mP9xRt 3 \"Say hello\""
    )]
    Slide(SlideArgs),
    /// Render one slide (or --all) to an image, exactly as a Carbon sees it. HTML elements run first.
    #[command(after_help = "Examples:\n  present render dk7Hq2mP9xRt 1 -o s1.png\n  present render dk7Hq2mP9xRt 3 --width 960 --format jpg -o s3.jpg\n  present render dk7Hq2mP9xRt 2 --at 4000 -o later.png    # let an animation run 4 s\n  present render dk7Hq2mP9xRt --all -o renders/\n\nThen look at the image, fix what you see with present set / replace, render again.")]
    Render {
        /// The deck.
        deck: DeckRef,
        /// The slide (number or id).
        slide: Option<String>,
        /// Every slide, into the directory given with -o.
        #[arg(long, conflicts_with = "slide")]
        all: bool,
        /// Where to write (a file, or a directory with --all). Default: <deck>-<n>.png here.
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Image width in pixels (default 1920).
        #[arg(long)]
        width: Option<u32>,
        /// Milliseconds HTML elements run before the picture (default 1500).
        #[arg(long)]
        at: Option<u64>,
        /// png or jpg.
        #[arg(long, default_value = "png")]
        format: String,
        /// Render the deck as it was at this version.
        #[arg(long)]
        version: Option<u64>,
    },
    /// Find decks you can see by title, slide text, notes or table text.
    #[command(after_help = "Example: present search \"revenue\" --json")]
    Search {
        /// What to look for.
        query: String,
    },

    // ---- editing ------------------------------------------------------------------------
    /// Apply raw edit ops (JSON) in one transaction: the whole change appears at once.
    #[command(after_help = "Examples:\n  present edit dk7Hq2mP9xRt --ops ops.json\n  echo '[{\"op\":\"update_slide\",\"slide\":\"s_ab12cd\",\"set\":{\"skipped\":true}}]' | present edit dk7Hq2mP9xRt --ops -\n  present edit dk7Hq2mP9xRt --ops ops.json --base 41 --summary \"Rebuilt slide 4\"\n\nThe file is an ops array or {\"base\",\"summary\",\"ops\"}. See: present docs ops")]
    Edit {
        /// The deck.
        deck: DeckRef,
        /// The ops file, or - for stdin.
        #[arg(long)]
        ops: String,
        /// The version the ops were written against (merges with newer edits).
        #[arg(long)]
        base: Option<u64>,
        /// What the change does, shown in the history.
        #[arg(long)]
        summary: Option<String>,
    },
    /// Add an element: text, shape, image, video, audio, table, chart or html.
    #[command(subcommand, after_help = "Examples:\n  present add text dk7Hq2mP9xRt 2 \"Hello\" --size 96 --bold\n  present add image dk7Hq2mP9xRt 2 photo.png\n  present add html dk7Hq2mP9xRt 3 --html w.html --js w.js\n\nEach prints the new element id first. Then: present render <deck> <slide>")]
    Add(AddCmd),
    /// Change element fields: key=value pairs (JSON values, dotted keys, @file).
    #[command(
        long_about = "Change any field of an element. Each pair is key=value: the value is read as JSON when it is valid JSON (numbers, true, null, {...}, [...], \"quoted\"), else as plain text. Dotted keys change one key of a plain value (style.fill=#ff0000). text=... sets plain text (one paragraph per line); html=@file.html reads a file.\n\nFields: x y w h rotation locked group link animation style.{fill,stroke,strokeWidth,radius,opacity,shadow,padding,verticalAlign} text shape src alt fit autoplay loop muted poster rows cols headerRow cells chart html css js.",
        after_help = "Examples:\n  present set dk7Hq2mP9xRt 2 e_ab12cd x=100 y=200 w=800\n  present set dk7Hq2mP9xRt 2 text:1 text=\"New title\" style.fill=#fff8f5\n  present set dk7Hq2mP9xRt 2 e_ab12cd 'animation={\"effect\":\"fade\",\"trigger\":\"click\",\"order\":1,\"duration\":400,\"delay\":0}'\n  present set dk7Hq2mP9xRt 3 e_html01 html=@chart.html js=@chart.js\n  present set dk7Hq2mP9xRt 2 e_ab12cd locked=true group=g1"
    )]
    Set {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The element.
        element: String,
        /// key=value pairs.
        #[arg(required = true)]
        pairs: Vec<String>,
    },
    /// Replace an exact passage in a slide's text, notes, HTML/CSS/JS or a table cell; keeps formatting and others' typing.
    #[command(after_help = "Examples:\n  present replace dk7Hq2mP9xRt 2 --find \"Q3\" --replace \"Q4\" --all\n  present replace dk7Hq2mP9xRt 2 e_ab12cd --find \"Helo\" --replace \"Hello\"\n  present replace dk7Hq2mP9xRt 2 --field notes --find \"TBD\" --replace \"Ship it\"\n  present replace dk7Hq2mP9xRt 4 e_html01 --field js --find \"speed = 1\" --replace \"speed = 2\"\n  present replace dk7Hq2mP9xRt 3 e_tab001 --field cell:1:2 --find 10 --replace 12\n\nFails with text_not_found (closest match in the hint) or text_ambiguous (use --all or a longer passage).")]
    Replace {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The element (leave out to search the whole slide).
        element: Option<String>,
        /// The exact passage.
        #[arg(long)]
        find: String,
        /// What replaces it.
        #[arg(long)]
        replace: String,
        /// Replace every occurrence.
        #[arg(long)]
        all: bool,
        /// text, notes, html, css, js or cell:r:c.
        #[arg(long)]
        field: Option<String>,
    },
    /// Bring an element to the front (or one step forward with --step).
    #[command(after_help = "Example: present front dk7Hq2mP9xRt 2 e_ab12cd")]
    Front {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The element.
        element: String,
        /// One step forward instead of all the way.
        #[arg(long)]
        step: bool,
    },
    /// Send an element to the back (or one step backward with --step).
    #[command(after_help = "Example: present back dk7Hq2mP9xRt 2 e_ab12cd")]
    Back {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The element.
        element: String,
        /// One step backward instead of all the way.
        #[arg(long)]
        step: bool,
    },
    /// Set the deck's theme: Paper, Ivory, Ink, Slate, Forest, Coral or Mono, with optional overrides.
    #[command(after_help = "Examples:\n  present theme dk7Hq2mP9xRt Ivory\n  present theme dk7Hq2mP9xRt Paper --heading \"Fraunces\" --color accent=#b4532a\n  present theme dk7Hq2mP9xRt --list")]
    Theme {
        /// The deck.
        deck: Option<DeckRef>,
        /// The theme name.
        name: Option<String>,
        /// Heading font family.
        #[arg(long)]
        heading: Option<String>,
        /// Body font family.
        #[arg(long)]
        body: Option<String>,
        /// Colour overrides: background, text, accent, accent2, accent3, muted.
        #[arg(long, value_name = "KEY=#HEX")]
        color: Vec<String>,
        /// List the themes.
        #[arg(long)]
        list: bool,
    },

    // ---- working in a folder ------------------------------------------------------------
    /// Bring a deck down as a folder: deck.json, slides/NN-<id>/slide.json, HTML elements as .html/.css/.js, assets/.
    #[command(after_help = "Examples:\n  present pull dk7Hq2mP9xRt\n  present pull dk7Hq2mP9xRt q4/\n  present pull dk7Hq2mP9xRt q4/ --version 12   # an older version (push merges it on top of today's deck)\n\nThen edit the files with any tools, `present status q4/`, `present push q4/`. Layout: present docs pull")]
    Pull {
        /// The deck.
        deck: DeckRef,
        /// The folder (default: the deck title, slugged).
        dir: Option<PathBuf>,
        /// Pull the deck as it was at this version.
        #[arg(long)]
        version: Option<u64>,
        /// Overwrite a folder that has local changes.
        #[arg(long)]
        force: bool,
    },
    /// Send a pulled folder's changes back; they merge with whatever others did since the pull.
    #[command(after_help = "Examples:\n  present push q4/\n  present push q4/ --summary \"Rebuilt slide 4\"\n  present push q4/ --dry-run --json      # the ops it would send\n\nAfter pushing, the folder is refreshed to the merged deck (unless --no-refresh).")]
    Push {
        /// The folder (default: here).
        dir: Option<PathBuf>,
        /// What the change does, shown in the history.
        #[arg(long)]
        summary: Option<String>,
        /// Show the ops without sending them.
        #[arg(long)]
        dry_run: bool,
        /// Don't refresh the folder after pushing.
        #[arg(long)]
        no_refresh: bool,
    },
    /// What changed in a pulled folder since the pull (the ops `push` would send).
    #[command(after_help = "Example: present status q4/ --json")]
    Status {
        /// The folder (default: here).
        dir: Option<PathBuf>,
    },

    // ---- comments ----------------------------------------------------------------------
    /// List a deck's comment threads, grouped by slide.
    #[command(after_help = "Examples:\n  present comments dk7Hq2mP9xRt\n  present comments dk7Hq2mP9xRt --all --json\n\nThen: present reply <thread> \"…\", present resolve <thread>")]
    Comments {
        /// The deck.
        deck: DeckRef,
        /// Resolved threads only.
        #[arg(long, conflicts_with = "all")]
        resolved: bool,
        /// Open and resolved.
        #[arg(long)]
        all: bool,
    },
    /// Comment on the deck, a slide, a point, an area, an element or some text; or edit/delete a comment.
    #[command(
        args_conflicts_with_subcommands = true,
        subcommand_negates_reqs = true,
        long_about = "Write a new comment. Pick what it is on:\n  --deck                          the whole deck\n  --slide N                       a whole slide\n  --slide N --point x,y           a point (slide px); add --element to pin it to an element\n  --slide N --area x,y,w,h        an area\n  --slide N --element ID          an element (an HTML element too)\n  --slide N --element ID --text \"quote\" [--field text|notes|cell:r:c]   some text\n\nMention a Carbon or Silicon with @c:id or @si:id in the body: they get a Silicon Ting.",
        after_help = "Examples:\n  present comment dk7Hq2mP9xRt --deck \"Looks great overall\"\n  present comment dk7Hq2mP9xRt --slide 2 --area 100,100,600,400 \"@si:designer make this simpler\"\n  present comment dk7Hq2mP9xRt --slide 3 --element e_ab12cd --text \"Q3 numbers\" \"These are Q4\"\n  present comment edit cm8Kq2mP9xRt \"Fixed wording\"\n  present comment delete cm8Kq2mP9xRt"
    )]
    Comment(CommentArgs),
    /// Reply in a thread.
    #[command(after_help = "Example: present reply th8Kq2mP9xRt \"Done in v43 @c:ada\"")]
    Reply {
        /// The thread.
        thread: String,
        /// The reply.
        body: String,
    },
    /// React to a comment with an emoji (--remove to take it back).
    #[command(after_help = "Examples:\n  present react cm8Kq2mP9xRt 👍\n  present react cm8Kq2mP9xRt 👍 --remove")]
    React {
        /// The comment.
        comment: String,
        /// The emoji.
        emoji: String,
        /// Remove your reaction.
        #[arg(long)]
        remove: bool,
    },
    /// Resolve a thread.
    #[command(after_help = "Example: present resolve th8Kq2mP9xRt")]
    Resolve {
        /// The thread.
        thread: String,
    },
    /// Reopen a resolved thread.
    #[command(after_help = "Example: present reopen th8Kq2mP9xRt")]
    Reopen {
        /// The thread.
        thread: String,
    },

    // ---- sharing -----------------------------------------------------------------------
    /// Invite a Carbon or Silicon (c:id, si:id or email) to a deck or folder as editor, commenter or viewer.
    #[command(after_help = "Examples:\n  present share dk7Hq2mP9xRt c:ada --role editor\n  present share dk7Hq2mP9xRt si:writer --role commenter\n  present share fd8Kq2mP9xRt ada@example.com --role viewer --folder\n\nThen: present access <deck>. Change a role by sharing again; remove with present unshare.")]
    Share {
        /// The deck (or folder with --folder).
        target: String,
        /// c:id, si:id or an email.
        to: String,
        /// editor, commenter or viewer.
        #[arg(long, value_enum)]
        role: RoleArg,
        /// The target is a folder.
        #[arg(long)]
        folder: bool,
    },
    /// Who can reach a deck or folder, and how.
    #[command(after_help = "Example: present access dk7Hq2mP9xRt --json")]
    Access {
        /// The deck (or folder with --folder).
        target: String,
        /// The target is a folder.
        #[arg(long)]
        folder: bool,
    },
    /// Remove someone's access (c:id, si:id, email, or the member key from `access`).
    #[command(after_help = "Example: present unshare dk7Hq2mP9xRt si:writer")]
    Unshare {
        /// The deck (or folder with --folder).
        target: String,
        /// Who.
        member: String,
        /// The target is a folder.
        #[arg(long)]
        folder: bool,
    },
    /// Make a deck public by link: off, view (no sign-in needed), comment or edit.
    #[command(after_help = "Examples:\n  present public dk7Hq2mP9xRt view\n  present public dk7Hq2mP9xRt off      # the link stops working")]
    Public {
        /// The deck.
        deck: DeckRef,
        /// off, view, comment or edit.
        #[arg(value_enum)]
        mode: PublicArg,
    },

    // ---- versions ----------------------------------------------------------------------
    /// The deck's history: who did what, newest first, with names and events.
    #[command(after_help = "Example: present versions dk7Hq2mP9xRt\nThen: present read <deck> --version N, present compare <deck> A B, present restore <deck> N")]
    Versions {
        /// The deck.
        deck: DeckRef,
    },
    /// Name a version (e.g. "Sent to the client").
    #[command(subcommand, after_help = "Example: present version name dk7Hq2mP9xRt 42 \"Sent to the client\"")]
    Version(VersionCmd),
    /// Compare two versions slide by slide.
    #[command(after_help = "Example: present compare dk7Hq2mP9xRt 12 20 --json")]
    Compare {
        /// The deck.
        deck: DeckRef,
        /// From version.
        from: u64,
        /// To version.
        to: u64,
    },
    /// Restore a whole version, or one slide or element from it (a new version; nothing is lost).
    #[command(after_help = "Examples:\n  present restore dk7Hq2mP9xRt 12\n  present restore dk7Hq2mP9xRt 12 --slide s_ab12cd\n  present restore dk7Hq2mP9xRt 12 --slide s_ab12cd --element e_cd34ef")]
    Restore {
        /// The deck.
        deck: DeckRef,
        /// The version.
        version: u64,
        /// Only this slide (id or number at that version).
        #[arg(long)]
        slide: Option<String>,
        /// Only this element (needs --slide).
        #[arg(long, requires = "slide")]
        element: Option<String>,
    },
    /// Undo everything one Carbon or Silicon changed since a version.
    #[command(name = "undo-account", after_help = "Example: present undo-account dk7Hq2mP9xRt si:intern --since 40")]
    UndoAccount {
        /// The deck.
        deck: DeckRef,
        /// c:id or si:id.
        account: String,
        /// Undo their changes after this version.
        #[arg(long)]
        since: u64,
    },

    // ---- files -------------------------------------------------------------------------
    /// Download a deck as pptx, ppt, key, odp, pdf, html, png or jpg (png/jpg of a whole deck is a zip).
    #[command(after_help = "Examples:\n  present export dk7Hq2mP9xRt --format pptx\n  present export dk7Hq2mP9xRt --format pdf -o q4.pdf\n  present export dk7Hq2mP9xRt --format png --slide 3 -o s3.png\n  present export dk7Hq2mP9xRt --format html --version 12")]
    Export {
        /// The deck.
        deck: DeckRef,
        /// pptx, ppt, key, odp, pdf, html, png or jpg.
        #[arg(long, value_enum)]
        format: ExportFormat,
        /// Where to write (default: the file name the service suggests, here).
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Export the deck as it was at this version.
        #[arg(long)]
        version: Option<u64>,
        /// Only this slide.
        #[arg(long)]
        slide: Option<String>,
    },

    // ---- presenting --------------------------------------------------------------------
    /// Presenting: start, next, prev, goto, stop, status, follow (the same as the top-level shortcuts).
    #[command(name = "show", visible_alias = "presentation", subcommand, after_help = "Examples:\n  present show start dk7Hq2mP9xRt\n  present show status --json\n\nShortcuts: present start|next|prev|goto|stop|follow")]
    Show(ShowCmd),
    /// Start presenting a deck; prints the link everyone can follow along with.
    #[command(after_help = "Examples:\n  present start dk7Hq2mP9xRt\n  present start dk7Hq2mP9xRt --slide 3 --json\n\nThen: present next, present prev, present goto 5, present stop")]
    Start {
        /// The deck.
        deck: DeckRef,
        /// Start on this slide.
        #[arg(long)]
        slide: Option<String>,
    },
    /// Next step or slide of the presentation you started.
    #[command(after_help = "Example: present next")]
    Next(PresentationRef),
    /// Previous step or slide.
    #[command(after_help = "Example: present prev")]
    Prev(PresentationRef),
    /// Go to a slide (number or id).
    #[command(after_help = "Example: present goto 5")]
    Goto {
        /// The slide.
        slide: String,
        /// The presentation (default: the last one started here).
        #[arg(long)]
        presentation: Option<String>,
    },
    /// Stop presenting.
    #[command(after_help = "Example: present stop")]
    Stop(PresentationRef),
    /// Follow a presentation live: one line per slide change until it ends.
    #[command(after_help = "Examples:\n  present follow pr8Kq2mP9xRt\n  present follow pr8Kq2mP9xRt --json --count 3")]
    Follow {
        /// The presentation id or follow link.
        presentation: String,
        /// Stop after this many state events.
        #[arg(long)]
        count: Option<u64>,
        /// Stop after this many seconds.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },

    // ---- following along ---------------------------------------------------------------
    /// Stream a deck's live changes, comments and presence: how a Silicon follows along.
    #[command(after_help = "Examples:\n  present watch dk7Hq2mP9xRt\n  present watch dk7Hq2mP9xRt --json                 # one JSON line per event\n  present watch dk7Hq2mP9xRt --json --here 3        # and show yourself on slide 3\n  present watch dk7Hq2mP9xRt --json --until comments --for 600\n\nEvents: sync, update (who changed what), presence, presence_left, comments, deck. Reconnects by itself.")]
    Watch {
        /// The deck.
        deck: DeckRef,
        /// Show yourself in the deck on this slide while watching.
        #[arg(long, value_name = "SLIDE")]
        here: Option<String>,
        /// Keep the Yjs update payloads (base64) in the output.
        #[arg(long)]
        raw: bool,
        /// Include pings.
        #[arg(long)]
        pings: bool,
        /// Stop after this many events (pings not counted).
        #[arg(long)]
        count: Option<u64>,
        /// Stop after the first event of this kind.
        #[arg(long, value_name = "EVENT")]
        until: Option<String>,
        /// Stop after this many seconds.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },

    // ---- other -------------------------------------------------------------------------
    /// Report a bug to the Silicon Present team, optionally with a pull request that fixes it.
    #[command(after_help = "Example: present report \"present push drops table fills: steps, expected, actual\" --pr https://github.com/teamofsilicons/silicon-present/pull/12\nNever include secrets.")]
    Report {
        /// What happened: steps, expected, actual.
        message: String,
        /// A pull request that fixes it.
        #[arg(long)]
        pr: Option<String>,
    },
}

/// `present login`.
#[derive(Debug, Args)]
pub struct LoginArgs {
    /// A short-lived token (slt_…).
    #[arg(value_name = "SLT", conflicts_with_all = ["slt", "slt_stdin"])]
    pub token: Option<String>,
    /// A short-lived token (slt_…) from `silicon-accounts login --app present -q`.
    #[arg(long, value_name = "SLT", conflicts_with = "slt_stdin")]
    pub slt: Option<String>,
    /// Read the short-lived token from stdin.
    #[arg(long)]
    pub slt_stdin: bool,
    /// Name this device in the Carbon's list of sign-ins (device flow).
    #[arg(long)]
    pub label: Option<String>,
    /// `status`.
    #[command(subcommand)]
    pub sub: Option<LoginSub>,
}

/// `present login status`.
#[derive(Debug, Subcommand)]
pub enum LoginSub {
    /// Who is signed in here; with --json always exits 0 ({"authenticated": false} when nobody).
    #[command(after_help = "Example: present login status --json\n→ {\"authenticated\":true,\"uuid\":…,\"id\":\"si:designer\",\"kind\":\"silicon\",…}")]
    Status {
        /// Read the saved file only (no refresh, no network).
        #[arg(long)]
        offline: bool,
    },
}

/// `present config`.
#[derive(Debug, Subcommand)]
pub enum ConfigCmd {
    /// Show or set the home where state lives ({home}/.present). Errors if it is not a directory.
    #[command(after_help = "Examples:\n  present config home\n  present config home /srv/silicons/designer")]
    Home {
        /// The new home directory.
        dir: Option<PathBuf>,
    },
    /// Save the API URL to use when --api-url / PRESENT_API_URL is not given.
    #[command(name = "api-url", after_help = "Example: present config api-url http://127.0.0.1:4321")]
    ApiUrl {
        /// The URL (`default` to forget it).
        url: String,
    },
    /// Save the Silicon Accounts URL to use when --accounts-url / ACCOUNTS_URL is not given.
    #[command(name = "accounts-url", after_help = "Example: present config accounts-url http://localhost:9740")]
    AccountsUrl {
        /// The URL (`default` to forget it).
        url: String,
    },
    /// Show every setting and where it comes from.
    #[command(after_help = "Example: present config show --json")]
    Show,
}

/// Transfer answers.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TransferAction {
    /// Take it.
    Accept,
    /// Say no.
    Decline,
    /// Withdraw your offer.
    Cancel,
}

/// Roles.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum RoleArg {
    /// Edit, comment and invite.
    Editor,
    /// View and comment.
    Commenter,
    /// View only.
    Viewer,
}

/// Public modes.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum PublicArg {
    /// Private.
    Off,
    /// Anyone with the link can view.
    View,
    /// Anyone signed in with the link can comment.
    Comment,
    /// Anyone signed in with the link can edit.
    Edit,
}

/// Export formats.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum ExportFormat {
    /// PowerPoint.
    Pptx,
    /// PowerPoint 97-2003.
    Ppt,
    /// Keynote.
    Key,
    /// OpenDocument.
    Odp,
    /// PDF.
    Pdf,
    /// One self-contained web page.
    Html,
    /// PNG (zip of every slide unless --slide).
    Png,
    /// JPG (zip of every slide unless --slide).
    Jpg,
}

impl ExportFormat {
    /// The format name the service takes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pptx => "pptx",
            Self::Ppt => "ppt",
            Self::Key => "key",
            Self::Odp => "odp",
            Self::Pdf => "pdf",
            Self::Html => "html",
            Self::Png => "png",
            Self::Jpg => "jpg",
        }
    }
}

/// `present folder`.
#[derive(Debug, Subcommand)]
pub enum FolderCmd {
    /// List folders (yours, shared with you, or in the trash).
    #[command(after_help = "Examples:\n  present folder list\n  present folder list --parent fd8Kq2mP9xRt\n  present folder list --shared --json")]
    List {
        /// Only folders inside this one.
        #[arg(long)]
        parent: Option<String>,
        /// Folders shared with you.
        #[arg(long, conflicts_with = "trash")]
        shared: bool,
        /// Your trash.
        #[arg(long)]
        trash: bool,
    },
    /// Make a folder.
    #[command(after_help = "Example: present folder new \"Clients\" --parent fd8Kq2mP9xRt\nThen: present new \"Deck\" --folder <folder>, present move <deck> <folder>")]
    New {
        /// Name.
        name: String,
        /// Inside this folder.
        #[arg(long)]
        parent: Option<String>,
    },
    /// Rename a folder.
    #[command(after_help = "Example: present folder rename fd8Kq2mP9xRt \"Clients 2026\"")]
    Rename {
        /// The folder.
        folder: String,
        /// The new name.
        name: String,
    },
    /// Move a folder into another (or `root`).
    #[command(name = "move", after_help = "Example: present folder move fd8Kq2mP9xRt root")]
    Move {
        /// The folder.
        folder: String,
        /// The new parent folder, or `root`.
        parent: String,
    },
    /// Put a folder (and everything in it) in the trash.
    #[command(after_help = "Example: present folder trash fd8Kq2mP9xRt")]
    Trash {
        /// The folder.
        folder: String,
    },
    /// Bring a folder back from the trash.
    #[command(after_help = "Example: present folder untrash fd8Kq2mP9xRt")]
    Untrash {
        /// The folder.
        folder: String,
    },
    /// Delete a trashed folder for good (type its name, or --confirm <name>).
    #[command(after_help = "Example: present folder delete fd8Kq2mP9xRt --confirm \"Old\"")]
    Delete {
        /// The folder.
        folder: String,
        /// The folder's exact name.
        #[arg(long)]
        confirm: Option<String>,
    },
    /// Share a folder (everything in it, including what is added later).
    #[command(after_help = "Example: present folder share fd8Kq2mP9xRt c:ada --role editor")]
    Share {
        /// The folder.
        folder: String,
        /// c:id, si:id or email.
        to: String,
        /// editor, commenter or viewer.
        #[arg(long, value_enum)]
        role: RoleArg,
    },
}

/// `present slide`.
#[derive(Debug, Args)]
pub struct SlideArgs {
    /// The deck.
    #[arg(required = true)]
    pub deck: Option<DeckRef>,
    /// The slide (number or id).
    #[arg(required = true)]
    pub slide: Option<String>,
    /// Change slides.
    #[command(subcommand)]
    pub sub: Option<SlideCmd>,
}

/// Slide changes.
#[derive(Debug, Subcommand)]
pub enum SlideCmd {
    /// Add a slide with a layout (title, title-body, two-columns, section, title-only, image-caption, blank).
    #[command(after_help = "Examples:\n  present slide add dk7Hq2mP9xRt --layout title --title \"Q4 review\" --subtitle \"October\"\n  present slide add dk7Hq2mP9xRt --after 2 --layout title-body --title \"Plan\" --body $'Hire\\nShip'\n  present slide add dk7Hq2mP9xRt --first --layout blank --json")]
    Add {
        /// The deck.
        deck: DeckRef,
        /// After this slide (default: at the end).
        #[arg(long, conflicts_with = "first")]
        after: Option<String>,
        /// As the first slide.
        #[arg(long)]
        first: bool,
        /// The layout.
        #[arg(long, default_value = "title-body")]
        layout: String,
        /// Title text.
        #[arg(long)]
        title: Option<String>,
        /// Subtitle text.
        #[arg(long)]
        subtitle: Option<String>,
        /// Body text (one bullet per line; left column of two-columns).
        #[arg(long)]
        body: Option<String>,
        /// Right column text (two-columns).
        #[arg(long)]
        right: Option<String>,
        /// Caption (image-caption).
        #[arg(long)]
        caption: Option<String>,
        /// Speaker notes.
        #[arg(long)]
        notes: Option<String>,
    },
    /// Copy a slide (new ids) right after it.
    #[command(after_help = "Example: present slide duplicate dk7Hq2mP9xRt 3")]
    Duplicate {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
    },
    /// Move a slide after another (or --first).
    #[command(name = "move", after_help = "Examples:\n  present slide move dk7Hq2mP9xRt 5 --after 2\n  present slide move dk7Hq2mP9xRt s_ab12cd --first")]
    Move {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// After this slide.
        #[arg(long, conflicts_with = "first", required_unless_present = "first")]
        after: Option<String>,
        /// To the front.
        #[arg(long)]
        first: bool,
    },
    /// Delete a slide.
    #[command(after_help = "Example: present slide delete dk7Hq2mP9xRt 4")]
    Delete {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
    },
    /// Skip a slide when presenting (--off to stop skipping it).
    #[command(after_help = "Example: present slide skip dk7Hq2mP9xRt 4")]
    Skip {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// Stop skipping it.
        #[arg(long)]
        off: bool,
    },
    /// Start a section at a slide (--clear to remove it).
    #[command(after_help = "Example: present slide section dk7Hq2mP9xRt 3 \"Results\"")]
    Section {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The section name.
        name: Option<String>,
        /// Remove the section.
        #[arg(long, conflicts_with = "name")]
        clear: bool,
    },
    /// Show or set a slide's speaker notes (text, --file, or - for stdin).
    #[command(after_help = "Examples:\n  present slide notes dk7Hq2mP9xRt 3\n  present slide notes dk7Hq2mP9xRt 3 \"Pause here\"\n  present slide notes dk7Hq2mP9xRt 3 --file notes.txt")]
    Notes {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The notes (- reads stdin).
        text: Option<String>,
        /// Read the notes from a file.
        #[arg(long, conflicts_with = "text")]
        file: Option<PathBuf>,
    },
    /// Set a slide's transition (fade, push, wipe, zoom, cover, or none).
    #[command(after_help = "Example: present slide transition dk7Hq2mP9xRt 3 push --duration 500 --direction left")]
    Transition {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// fade, push, wipe, zoom, cover or none.
        kind: String,
        /// Milliseconds.
        #[arg(long, default_value_t = 400)]
        duration: u64,
        /// left, right, up or down.
        #[arg(long)]
        direction: Option<String>,
    },
    /// Set a slide's background: a colour (#hex), an image file or URL, or none.
    #[command(after_help = "Examples:\n  present slide background dk7Hq2mP9xRt 1 \"#111214\"\n  present slide background dk7Hq2mP9xRt 1 cover.jpg --fit cover\n  present slide background dk7Hq2mP9xRt 1 none")]
    Background {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// #hex, an image file, a URL, asset:<id>, or none.
        value: String,
        /// cover or contain (images).
        #[arg(long, default_value = "cover")]
        fit: String,
    },
    /// Change a slide's layout name.
    #[command(after_help = "Example: present slide layout dk7Hq2mP9xRt 2 two-columns")]
    Layout {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The layout.
        layout: String,
    },
    /// Show or hide the master elements on a slide.
    #[command(after_help = "Example: present slide master dk7Hq2mP9xRt 1 --hide")]
    Master {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// Hide the master on this slide (else show it).
        #[arg(long)]
        hide: bool,
    },
}

/// Where a new element goes and how big it is.
#[derive(Debug, Args, Clone, Default)]
pub struct FrameArgs {
    /// Left, slide px (slides are 1920×1080 unless the deck says otherwise).
    #[arg(long)]
    pub x: Option<f64>,
    /// Top, slide px.
    #[arg(long)]
    pub y: Option<f64>,
    /// Width, slide px.
    #[arg(long)]
    pub w: Option<f64>,
    /// Height, slide px.
    #[arg(long)]
    pub h: Option<f64>,
    /// Put it on the master (under every slide) instead of the given slide.
    #[arg(long)]
    pub master: bool,
}

/// Text formatting for new text.
#[derive(Debug, Args, Clone, Default)]
pub struct TextStyleArgs {
    /// Font size, px.
    #[arg(long)]
    pub size: Option<f64>,
    /// Bold.
    #[arg(long)]
    pub bold: bool,
    /// Italic.
    #[arg(long)]
    pub italic: bool,
    /// Text colour (#hex).
    #[arg(long)]
    pub color: Option<String>,
    /// Font family.
    #[arg(long)]
    pub font: Option<String>,
    /// left, center, right or justify.
    #[arg(long)]
    pub align: Option<String>,
    /// Heading level 1-3.
    #[arg(long)]
    pub heading: Option<u8>,
    /// bullet or ordered.
    #[arg(long)]
    pub list: Option<String>,
    /// Fill colour of the box (#hex).
    #[arg(long)]
    pub fill: Option<String>,
    /// top, middle or bottom.
    #[arg(long)]
    pub valign: Option<String>,
    /// Link the whole element to a URL or slide:<id>.
    #[arg(long)]
    pub link: Option<String>,
}

/// `present add`.
#[derive(Debug, Subcommand)]
pub enum AddCmd {
    /// Add a text box.
    #[command(after_help = "Examples:\n  present add text dk7Hq2mP9xRt 2 \"Revenue grew 40%\" --x 140 --y 300 --w 1640 --h 200 --size 72 --bold\n  present add text dk7Hq2mP9xRt 2 $'One\\nTwo\\nThree' --list bullet\n\nPrints the new element id. Then: present render <deck> 2")]
    Text {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The text (one paragraph per line; - reads stdin).
        text: String,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
        /// How it looks.
        #[command(flatten)]
        style: TextStyleArgs,
    },
    /// Add a shape (rect, round-rect, ellipse, triangle, star, arrow-right, line, ...), optionally with text.
    #[command(after_help = "Examples:\n  present add shape dk7Hq2mP9xRt 2 ellipse --fill \"#2f5bea\" --x 100 --y 100 --w 300 --h 300\n  present add shape dk7Hq2mP9xRt 2 round-rect --text \"Step 1\" --fill \"#eef1f5\" --stroke \"#3a5a80\"")]
    Shape {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// The shape.
        shape: String,
        /// Text inside the shape.
        #[arg(long)]
        text: Option<String>,
        /// Outline colour.
        #[arg(long)]
        stroke: Option<String>,
        /// Outline width, px.
        #[arg(long)]
        stroke_width: Option<f64>,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
        /// How it looks.
        #[command(flatten)]
        style: TextStyleArgs,
    },
    /// Add an image: a local file (uploaded), a URL or asset:<id>.
    #[command(after_help = "Examples:\n  present add image dk7Hq2mP9xRt 2 chart.png --x 960 --y 200 --w 800 --h 600\n  present add image dk7Hq2mP9xRt 2 https://example.com/logo.svg --alt \"Logo\" --fit contain")]
    Image {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// File, URL or asset:<id>.
        source: String,
        /// Alt text.
        #[arg(long, default_value = "")]
        alt: String,
        /// cover, contain or fill.
        #[arg(long, default_value = "contain")]
        fit: String,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
    /// Add a video: a local file (uploaded), a URL or asset:<id>.
    #[command(after_help = "Example: present add video dk7Hq2mP9xRt 3 demo.mp4 --autoplay --muted --loop")]
    Video {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// File, URL or asset:<id>.
        source: String,
        /// Poster image (file, URL or asset:<id>).
        #[arg(long)]
        poster: Option<String>,
        /// Start playing by itself.
        #[arg(long)]
        autoplay: bool,
        /// Loop.
        #[arg(long = "loop")]
        looped: bool,
        /// No sound.
        #[arg(long)]
        muted: bool,
        /// Alt text.
        #[arg(long, default_value = "")]
        alt: String,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
    /// Add audio: a local file (uploaded), a URL or asset:<id>.
    #[command(after_help = "Example: present add audio dk7Hq2mP9xRt 1 intro.mp3 --autoplay")]
    Audio {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// File, URL or asset:<id>.
        source: String,
        /// Start playing by itself.
        #[arg(long)]
        autoplay: bool,
        /// Loop.
        #[arg(long = "loop")]
        looped: bool,
        /// Alt text.
        #[arg(long, default_value = "")]
        alt: String,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
    /// Add a table, from --rows/--cols, --cell r,c=text, or a CSV file.
    #[command(after_help = "Examples:\n  present add table dk7Hq2mP9xRt 3 --csv numbers.csv --header\n  present add table dk7Hq2mP9xRt 3 --rows 2 --cols 2 --cell 0,0=Q3 --cell 0,1=Q4 --cell 1,0=10 --cell 1,1=14")]
    Table {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// Rows (default: from the CSV).
        #[arg(long)]
        rows: Option<usize>,
        /// Columns (default: from the CSV).
        #[arg(long)]
        cols: Option<usize>,
        /// A CSV file with the cells.
        #[arg(long)]
        csv: Option<PathBuf>,
        /// One cell: r,c=text (0-based).
        #[arg(long)]
        cell: Vec<String>,
        /// The first row is a header.
        #[arg(long)]
        header: bool,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
    /// Add a chart (bar, column, line, area, pie, donut, scatter).
    #[command(after_help = "Example: present add chart dk7Hq2mP9xRt 3 --type column --labels Q1,Q2,Q3,Q4 --series \"Revenue=10,12,15,21\" --series \"Cost=8,9,9,10\" --title \"2026\"")]
    Chart {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// bar, column, line, area, pie, donut or scatter.
        #[arg(long = "type", default_value = "column")]
        kind: String,
        /// Category labels, comma separated.
        #[arg(long, value_delimiter = ',')]
        labels: Vec<String>,
        /// A series: name=v1,v2,... (repeat for more; name=v1,v2@#hex for a colour).
        #[arg(long)]
        series: Vec<String>,
        /// Chart title.
        #[arg(long)]
        title: Option<String>,
        /// Hide the legend.
        #[arg(long)]
        no_legend: bool,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
    /// Add a live HTML element from files: it renders, animates and runs its JS, sandboxed.
    #[command(after_help = "Examples:\n  present add html dk7Hq2mP9xRt 4 --html chart.html --css chart.css --js chart.js --x 0 --y 0 --w 1920 --h 1080\n  present add html dk7Hq2mP9xRt 4 --html - < widget.html\n\nIt can load libraries, fonts and data from the internet; it can never reach the viewer's account or the rest of the deck. See it with: present render <deck> 4 --at 3000")]
    Html {
        /// The deck.
        deck: DeckRef,
        /// The slide.
        slide: String,
        /// HTML file (- reads stdin).
        #[arg(long)]
        html: Option<String>,
        /// CSS file.
        #[arg(long)]
        css: Option<PathBuf>,
        /// JS file.
        #[arg(long)]
        js: Option<PathBuf>,
        /// Where.
        #[command(flatten)]
        frame: FrameArgs,
    },
}

/// `present comment`.
#[derive(Debug, Args)]
pub struct CommentArgs {
    /// The deck.
    #[arg(required = true)]
    pub deck: Option<DeckRef>,
    /// The comment (mention with @c:id / @si:id).
    #[arg(required = true)]
    pub body: Option<String>,
    /// On the whole deck.
    #[arg(long = "deck", id = "deck_wide", conflicts_with = "slide")]
    pub deck_wide: bool,
    /// On this slide.
    #[arg(long)]
    pub slide: Option<String>,
    /// On (or pinned to) this element.
    #[arg(long, requires = "slide")]
    pub element: Option<String>,
    /// On a point: x,y in slide px.
    #[arg(long, requires = "slide", conflicts_with = "area")]
    pub point: Option<String>,
    /// On an area: x,y,w,h in slide px.
    #[arg(long, requires = "slide")]
    pub area: Option<String>,
    /// On this exact text inside the element (or the notes with --field notes).
    #[arg(long, requires = "slide")]
    pub text: Option<String>,
    /// text, notes or cell:r:c (with --text).
    #[arg(long, requires = "text")]
    pub field: Option<String>,
    /// edit or delete.
    #[command(subcommand)]
    pub sub: Option<CommentCmd>,
}

/// `present comment edit|delete`.
#[derive(Debug, Subcommand)]
pub enum CommentCmd {
    /// Change your comment's text.
    #[command(after_help = "Example: present comment edit cm8Kq2mP9xRt \"Better wording\"")]
    Edit {
        /// The comment.
        comment: String,
        /// The new text.
        body: String,
    },
    /// Delete your comment (kept in the history).
    #[command(after_help = "Example: present comment delete cm8Kq2mP9xRt")]
    Delete {
        /// The comment.
        comment: String,
    },
}

/// `present version`.
#[derive(Debug, Subcommand)]
pub enum VersionCmd {
    /// Name a version so it is easy to find again.
    #[command(after_help = "Example: present version name dk7Hq2mP9xRt 42 \"Sent to the client\"")]
    Name {
        /// The deck.
        deck: DeckRef,
        /// The version.
        version: u64,
        /// The name.
        name: String,
    },
}

/// A presentation, defaulting to the last one started here.
#[derive(Debug, Args)]
pub struct PresentationRef {
    /// The presentation (default: the last one started here).
    #[arg(long)]
    pub presentation: Option<String>,
}

/// `present show`.
#[derive(Debug, Subcommand)]
pub enum ShowCmd {
    /// Start presenting (same as `present start`).
    #[command(after_help = "Example: present show start dk7Hq2mP9xRt")]
    Start {
        /// The deck.
        deck: DeckRef,
        /// Start on this slide.
        #[arg(long)]
        slide: Option<String>,
    },
    /// Next step or slide.
    #[command(after_help = "Example: present show next")]
    Next(PresentationRef),
    /// Previous step or slide.
    #[command(after_help = "Example: present show prev")]
    Prev(PresentationRef),
    /// Go to a slide.
    #[command(after_help = "Example: present show goto 5")]
    Goto {
        /// The slide.
        slide: String,
        /// The presentation.
        #[arg(long)]
        presentation: Option<String>,
    },
    /// Stop presenting.
    #[command(after_help = "Example: present show stop")]
    Stop(PresentationRef),
    /// Where the presentation is.
    #[command(after_help = "Example: present show status --json")]
    Status(PresentationRef),
    /// Follow a presentation live.
    #[command(after_help = "Example: present show follow pr8Kq2mP9xRt --json")]
    Follow {
        /// The presentation id or link.
        presentation: String,
        /// Stop after this many state events.
        #[arg(long)]
        count: Option<u64>,
        /// Stop after this many seconds.
        #[arg(long, value_name = "SECONDS")]
        r#for: Option<u64>,
    },
}
