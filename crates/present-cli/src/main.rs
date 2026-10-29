//! `present`: the Silicon Present command line. Everything the web editor can do, for Silicons
//! first, built only on the `silicon-present-client` package.

// A failure carries the service's whole answer so a Silicon can act on it; failures end the run,
// so their size does not matter.
#![allow(clippy::result_large_err)]

// Remote deck content is untrusted terminal text, including errors and live events.
macro_rules! println {
    () => { std::println!() };
    ($($arg:tt)*) => { std::println!("{}", crate::terminal::safe(&format!($($arg)*))) };
}
macro_rules! print {
    ($($arg:tt)*) => { std::print!("{}", crate::terminal::safe(&format!($($arg)*))) };
}
macro_rules! eprintln {
    ($($arg:tt)*) => { std::eprintln!("{}", crate::terminal::safe(&format!($($arg)*))) };
}
macro_rules! eprint {
    ($($arg:tt)*) => { std::eprint!("{}", crate::terminal::safe(&format!($($arg)*))) };
}

mod args;
mod cmd;
mod ctx;
mod docs;
mod fail;
mod state;
mod terminal;

use args::{Cli, Command, LayerDirection, LoginSub, ShowCmd, SlideArgs, VersionCmd};
use clap::Parser as _;
use ctx::Ctx;
use fail::{Fail, R};
use silicon_present_client::RenderOptions;

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json = cli.json;
    let result = match Ctx::new(cli.json, cli.api_url.clone(), cli.accounts_url.clone()) {
        Ok(mut ctx) => {
            ctx.dangerously_use_em_dash = cli.dangerously_use_em_dash;
            ctx.dangerously_add_long_text = cli.dangerously_add_long_text;
            run(&ctx, cli.command).await
        },
        Err(f) => Err(f),
    };
    if let Err(f) = result {
        if json {
            eprintln!("{}", f.to_json());
        } else {
            eprintln!("{}", f.render());
        }
        std::process::exit(1);
    }
}

async fn run(ctx: &Ctx, command: Command) -> R<()> {
    use cmd::{auth, collab, decks, edit, layers, live, sync};
    match command {
        Command::Login(a) => match a.sub {
            Some(LoginSub::Status { offline }) => auth::status(ctx, offline).await,
            None => auth::login(ctx, &a).await,
        },
        Command::Logout => auth::logout(ctx).await,
        Command::Accounts => auth::accounts_info(ctx),
        Command::Whoami => auth::whoami(ctx).await,
        Command::Config(c) => auth::config(ctx, &c),
        Command::Docs { topic } => docs::show(ctx, topic.as_deref()),

        Command::List { shared, trash, folder } => decks::list(ctx, shared, trash, folder.as_deref()).await,
        Command::New { title, folder, from } => decks::new(ctx, &title, folder.as_deref(), from.as_deref()).await,
        Command::Open { file, into, folder } => decks::open(ctx, &file, into.as_deref(), folder.as_deref()).await,
        Command::Rename { deck, title } => decks::rename(ctx, &deck, &title).await,
        Command::Move { deck, folder } => decks::move_deck(ctx, &deck, &folder).await,
        Command::Trash { deck } => decks::trash(ctx, &deck).await,
        Command::Untrash { deck } => decks::untrash(ctx, &deck).await,
        Command::Delete { deck, slide, element, permanent, confirm } => match (slide, element, permanent) {
            (Some(s), Some(e), false) => edit::delete_element(ctx, &deck, &s, &e).await,
            (None, None, true) => decks::delete_permanent(ctx, &deck, confirm.as_deref()).await,
            (Some(_), None, false) => Err(Fail::new(
                "missing_argument",
                "Which element? `present delete <deck> <slide> <element>` deletes an element.",
                "To delete a slide: present slide delete <deck> <slide>. To delete a deck for good: present trash <deck>, then present delete <deck> --permanent.",
            )),
            (None, None, false) => Err(Fail::new(
                "permanent_needed",
                "Deleting a deck needs --permanent, and only works for decks in the trash.",
                format!("Usually you want the trash: present trash {deck}. For good: present delete {deck} --permanent."),
            )),
            _ => Err(Fail::new(
                "invalid_input",
                "--permanent deletes a whole deck; it can't be combined with a slide or element.",
                "Delete an element with `present delete <deck> <slide> <element>`.",
            )),
        },
        Command::Transfer { target, to, folder } => decks::transfer(ctx, &target, &to, folder).await,
        Command::Transfers { action, id } => decks::transfers(ctx, action, id.as_deref()).await,
        Command::Folder(f) => decks::folder(ctx, &f).await,

        Command::Read { deck, version, comments } => edit::read(ctx, &deck, version, comments).await,
        Command::Slide(SlideArgs { deck, slide, sub }) => match sub {
            Some(s) => edit::slide_cmd(ctx, &s).await,
            None => edit::slide_show(ctx, &deck.unwrap_or_default(), &slide.unwrap_or_default()).await,
        },
        Command::Layers(args) => layers::run(ctx, &args).await,
        Command::Render { deck, slide, all, output, width, at, format, version } => {
            let opts = RenderOptions { format: Some(format), width, version, at };
            edit::render(ctx, &deck, slide.as_deref(), all, output.as_deref(), opts).await
        }
        Command::Search { query } => decks::search(ctx, &query).await,

        Command::Edit { deck, ops, base, summary } => edit::edit_raw(ctx, &deck, &ops, base, summary.as_deref()).await,
        Command::Add(a) => edit::add(ctx, &a).await,
        Command::Set { deck, slide, element, pairs } => edit::set(ctx, &deck, &slide, &element, &pairs).await,
        Command::Replace { deck, slide, element, find, replace, all, field } => {
            edit::replace(ctx, &deck, &slide, element.as_deref(), &find, &replace, all, field.as_deref()).await
        }
        Command::Front { deck, slide, element, step } => layers::move_layers(ctx, &deck, &slide, &[element], layers::Destination::Direction(if step { LayerDirection::Forward } else { LayerDirection::Front })).await,
        Command::Back { deck, slide, element, step } => layers::move_layers(ctx, &deck, &slide, &[element], layers::Destination::Direction(if step { LayerDirection::Backward } else { LayerDirection::Back })).await,
        Command::Theme { deck, name, heading, body, color, list, save, delete, rename, to } => {
            let manage = edit::ThemeManage { save: save.as_deref(), delete: delete.as_deref(), rename: rename.as_deref(), to: to.as_deref() };
            edit::theme(ctx, deck.as_deref(), name.as_deref(), heading.as_deref(), body.as_deref(), &color, list, manage).await
        }

        Command::Pull { deck, dir, version, force } => sync::pull(ctx, &deck, dir.as_deref(), version, force).await,
        Command::Push { dir, summary, dry_run, no_refresh } => sync::push(ctx, dir.as_deref(), summary.as_deref(), dry_run, no_refresh).await,
        Command::Status { dir } => sync::status(ctx, dir.as_deref()).await,

        Command::Comments { deck, resolved, all } => collab::list(ctx, &deck, resolved, all).await,
        Command::Comment(a) => collab::comment(ctx, &a).await,
        Command::Reply { thread, body } => collab::reply(ctx, &thread, &body).await,
        Command::React { comment, emoji, remove } => collab::react(ctx, &comment, &emoji, remove).await,
        Command::Resolve { thread } => collab::resolve(ctx, &thread, false).await,
        Command::Reopen { thread } => collab::resolve(ctx, &thread, true).await,

        Command::Share { target, to, role, folder } => collab::share(ctx, &target, &to, role, folder).await,
        Command::Access { target, folder } => collab::access(ctx, &target, folder).await,
        Command::Unshare { target, member, folder } => collab::unshare(ctx, &target, &member, folder).await,
        Command::Public { deck, mode } => collab::public(ctx, &deck, mode).await,

        Command::Versions { deck } => collab::versions(ctx, &deck).await,
        Command::Version(VersionCmd::Name { deck, version, name }) => collab::name_version(ctx, &deck, version, &name).await,
        Command::Compare { deck, from, to } => collab::compare(ctx, &deck, from, to).await,
        Command::Restore { deck, version, slide, element } => collab::restore(ctx, &deck, version, slide.as_deref(), element.as_deref()).await,
        Command::UndoAccount { deck, account, since } => collab::undo_account(ctx, &deck, &account, since).await,

        Command::Export { deck, format, output, version, slide } => live::export(ctx, &deck, format, output.as_deref(), version, slide.as_deref()).await,

        Command::Show(s) => match s {
            ShowCmd::Start { deck, slide } => live::start(ctx, &deck, slide.as_deref()).await,
            ShowCmd::Next(p) => live::step(ctx, p.presentation.as_deref(), 1).await,
            ShowCmd::Prev(p) => live::step(ctx, p.presentation.as_deref(), -1).await,
            ShowCmd::Goto { slide, presentation } => live::goto(ctx, presentation.as_deref(), &slide).await,
            ShowCmd::Stop(p) => live::stop(ctx, p.presentation.as_deref()).await,
            ShowCmd::Status(p) => live::status(ctx, p.presentation.as_deref()).await,
            ShowCmd::Follow { presentation, count, r#for } => live::follow(ctx, &presentation, count, r#for).await,
        },
        Command::Start { deck, slide } => live::start(ctx, &deck, slide.as_deref()).await,
        Command::Next(p) => live::step(ctx, p.presentation.as_deref(), 1).await,
        Command::Prev(p) => live::step(ctx, p.presentation.as_deref(), -1).await,
        Command::Goto { slide, presentation } => live::goto(ctx, presentation.as_deref(), &slide).await,
        Command::Stop(p) => live::stop(ctx, p.presentation.as_deref()).await,
        Command::Follow { presentation, count, r#for } => live::follow(ctx, &presentation, count, r#for).await,

        Command::Watch { deck, here, raw, pings, count, until, r#for } => {
            live::watch(ctx, &deck, here.as_deref(), raw, pings, count, until.as_deref(), r#for).await
        }
        Command::Report { message, pr } => live::report(ctx, &message, pr.as_deref()).await,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_command_tree_is_consistent() {
        use clap::CommandFactory as _;
        crate::args::Cli::command().debug_assert();
    }

    #[test]
    fn every_command_has_an_about_and_an_example() {
        use clap::CommandFactory as _;
        fn walk(cmd: &clap::Command, path: &str) {
            for sub in cmd.get_subcommands() {
                let p = format!("{path} {}", sub.get_name());
                assert!(sub.get_about().is_some(), "{p} has no about");
                let after = sub.get_after_help().map(ToString::to_string).unwrap_or_default();
                assert!(after.contains("Example"), "{p} has no example");
                walk(sub, &p);
            }
        }
        walk(&crate::args::Cli::command(), "present");
    }
}
