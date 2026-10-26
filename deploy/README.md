# Silicon Present production

The first deployment runs on one Ubuntu 24.04 ARM64 EC2 instance. The Rust service keeps live rooms in memory,
so run one service process. Caddy terminates HTTPS for `present.teamofsilicons.com` (Next.js) and
`backend.present.teamofsilicons.com` (the Rust API). PostgreSQL 16, the converter and both application listeners bind
to loopback. The converter is never public. Only ports 80 and 443 have inbound security-group rules; use SSM for
administration, with no SSH key or SSH ingress.

## Infrastructure

`stack.json` provisions a `t4g.medium` (`t4g.large` is also allowed), an Elastic IP, a 60 GiB encrypted gp3 root
volume, the instance role and a private, encrypted, versioned bucket for releases and backups. The root disk has
`DeleteOnTermination: false`; the bucket and Elastic IP have retention policies. Keep the returned volume,
bucket and IP identifiers with the deployment record. A terminated instance's retained root volume is not
automatically attached to a replacement. Replacing a host requires an explicit data recovery step.

The instance requires IMDSv2 with a one-hop limit. Its role permits SSM management, reading only `AppSecretArn`,
reading the stack bucket's `releases/` objects and writing its `backups/` objects. It cannot list or read unrelated
buckets or secrets. The runtime secret should use the default Secrets Manager encryption key; a customer-managed
KMS key needs a separately reviewed, key-scoped decrypt grant. The VPC/subnet must have outbound internet access
for Ubuntu packages, SSM, Accounts, Ting, mail, and public resources used by slides.

Parameters are `VpcId`, `SubnetId`, `AppSecretArn`, optional `InstanceType`, and `AmiId`. The AMI defaults to
Canonical's [Ubuntu 24.04 ARM64 SSM parameter](https://documentation.ubuntu.com/aws/aws-how-to/instances/build-cloudformation-templates/).
Use the chosen production profile and region consistently; no account or subnet is embedded in this template.
Create the stack with `CAPABILITY_IAM` and stack termination protection. Record the resolved AMI ID and do not
replace the instance for routine releases. The template's user data is an exact copy of `bootstrap.sh`; update
both together. CloudFormation reaching `CREATE_COMPLETE` does not mean cloud-init or the app is ready.

`bootstrap.sh` installs signed Ubuntu packages: PostgreSQL 16, LibreOffice Impress/Draw, poppler, ffmpeg, fonts,
Python, compiler dependencies, and Chromium libraries. AWS CLI uses the
[official AWS-supported snap](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
It enables the Ubuntu SSM snap using the
[AWS-supported installation path](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-ubuntu-64-snap.html).
It writes `/opt/present/bootstrap-complete` only after all steps succeed. It does not read app secrets or install
an app release. Check `cloud-init status --wait`, the marker, and SSM online status before installing.

## Runtime

Build the Rust `present-service` for Linux ARM64, including the patched `vendor/yrs` dependency. Build the web with
`NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-production`. The release copies `web/.next-production/standalone`
to `web/`, preserving its monorepo layout: the entrypoint is `web/web/server.js`, with public files in
`web/web/public` and static files in `web/web/.next-production/static`. The application uses Node 24 and pnpm 10.33.0.

The converter runs `renderer/src/server.ts` with `tsx` and needs the repository's pnpm workspace packages. Install
the pinned Playwright Chromium for Linux ARM64 on the deployment host or package that exact architecture's browser.
Do not package the development Mac's browser or native Node modules. The installer runs the converter as
`present-converter`, with read-only release files and `/var/lib/present-converter/tmp` owned by that account with
mode 0700; its parent remains root-owned with mode 0755. LibreOffice runs through `/usr/local/bin/present-soffice`,
a fixed-purpose sudo launcher for the root-owned `/usr/local/libexec/present-soffice-sandbox` helper. The helper
validates conversion arguments and temporary paths, creates isolated mount/network/process namespaces with
bubblewrap, then drops to the converter UID with no capabilities before parsing the document. It exposes public
runtime files and the converter temporary directory, not app secrets or network access. The converter unit allows
the narrow sudo handoff (`NoNewPrivileges=false`); the helper drops privileges inside the sandbox.

| Component | Settings |
| --- | --- |
| Service | `PRESENT_BIND=127.0.0.1:4321`, `PRESENT_DATABASE_URL`, `PRESENT_DATA_DIR=/var/lib/present/data`, `PRESENT_PUBLIC_URL=https://backend.present.teamofsilicons.com`, `PRESENT_WEB_URL=https://present.teamofsilicons.com` |
| Service identity | `ACCOUNTS_URL=https://accounts.teamofsilicons.com`, `PRESENT_APP_ID=present`, `PRESENT_APP_SECRET`, `PRESENT_ACCOUNTS_WEBHOOK_SECRET` |
| Converter link | Service: `PRESENT_CONVERTER_URL=http://127.0.0.1:4322`, `CONVERTER_SECRET`; converter: the same secret and `CONVERTER_PORT=4322` |
| Converter tools | `SOFFICE_PATH=/usr/local/bin/present-soffice`, `PDFTOPPM_PATH=/usr/bin/pdftoppm`, `PDFTOTEXT_PATH=/usr/bin/pdftotext`, `PDFTOCAIRO_PATH=/usr/bin/pdftocairo`, `PDFINFO_PATH=/usr/bin/pdfinfo`, `FFMPEG_PATH=/usr/bin/ffmpeg`, `CONVERTER_TMP=/var/lib/present-converter/tmp`, `PLAYWRIGHT_BROWSERS_PATH=/opt/present/browsers` |
| Notifications | `PRESENT_TING_URL=https://backend.ting.teamofsilicons.com`, `PRESENT_POSTMARK_TOKEN`, `PRESENT_MAIL_FROM=present@teamofsilicons.com` |
| Web | `APP_ID=present`, `APP_SECRET`, `SESSION_SECRET`, `ACCOUNTS_URL=https://accounts.teamofsilicons.com`, `APP_API_URL=http://127.0.0.1:4321`, `PUBLIC_URL=https://present.teamofsilicons.com`, `NODE_ENV=production`, `HOSTNAME=127.0.0.1`, `PORT=4320` |

Store secrets in Secrets Manager and root-owned environment files. Keep the web session secret stable across
releases. The service's public URL is used both in upload responses and signed converter asset URLs, so it must be
reachable by clients. The converter fetches signed assets through the public backend HTTPS origin; verify DNS and
Caddy TLS before testing renders or exports containing uploaded assets. `/health` does not depend on those asset
fetches. Public HTTP resources pass through the converter's DNS-pinned network policy.
Caddy must stream SSE without buffering and preserve the application's response security headers, including
the special sandbox page's policy. Do not put a global `script-src` override on that page.

Native Keynote conversion requires macOS and Apple Keynote automation. On Linux, `.key` import first fails that
native path, then attempts LibreOffice's limited Keynote reader. Older supported files may open, with an import
warning that formatting, editable shapes or hidden-slide state may be lost; other files can still fail. `.key`
export has no LibreOffice fallback and returns `keynote_unavailable`. PPTX remains interoperable with Keynote.
Do not claim general `.key` compatibility for this host. Verify imports and exports using representative files.

## Provisioning and release checks

1. Verify the AWS caller, production region, VPC and public subnet. Create the scoped Present runtime secret,
   provision the stack, record all outputs, and wait for bootstrap and SSM readiness.
2. Register or confirm the Silicon Accounts `present` app and owner. Enable device flow and public client, set
   `https://present.teamofsilicons.com/auth/callback` as a redirect URI, and configure the webhook at
   `https://backend.present.teamofsilicons.com/v1/accounts/webhook`.
3. Register Present's notification types with Silicon Ting and verify the Accounts proof grants for
   `tings.send` and `subscriptions.register`. Configure the verified mail sender for invitations and reports.
4. Install a checksum-verified release using `install.py`, preserving revision/build evidence. The service runs
   additive migrations at startup; retain a PostgreSQL dump and asset backup before changing a running release.
   The installer restores the previous release, environment files, units and service state if a later install or
   local readiness check fails. It does not rewind the database, so migrations must remain compatible with the
   previous release. A failed first installation leaves the incomplete app stopped.
5. Point the two DNS names at the stack Elastic IP, preserving unrelated records. Verify Caddy certificates,
   public HTTPS, API `/health`, and the converter's local `/health`. These checks do not prove authentication or
   editing works.
6. Complete a real Accounts sign-in and a live deck create/edit/reload, comment, public-link, presentation,
   upload, import and export journey. Verify Ting delivery, invitation email and Accounts webhook delivery.
   Record both successful cases and unsupported formats, plus the deployed revision.

The installer takes a pre-deployment PostgreSQL custom dump and asset tarball while the API is stopped.
`present-backup.timer` repeats that consistent backup daily at 03:15 UTC (08:45 IST), with up to five minutes of
jitter. Deployment and scheduled backups share a lock. Files live in `/var/lib/present-backups`, upload under
`backups/` in the retained stack bucket, and local files older than three days are removed after a successful
scheduled upload. Backups briefly interrupt the API. The S3 lifecycle expires current backup objects after
30 days and removes noncurrent versions 30 days after they become noncurrent; versioning can therefore retain
the bytes beyond the first 30 days. Release objects are not expired automatically. Record revision, timestamps
and checksums with each release, and test restoration into a separate database before claiming recovery works.
A single host has host-level downtime risk.
