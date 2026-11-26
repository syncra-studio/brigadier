//! A message command's options as the book reads them: never its words, whether they come as
//! `send <id> <text>`, `queue <id> add <text>` or a start's `--text` [C65].

/// What follows `send <id> <text>`, `queue <id> add <text>` or `start <id>`.
pub(crate) fn opts(args: &[String]) -> &[String] {
    let n = match args.first().map(String::as_str) {
        Some("queue") => 4,
        Some("start") => 2,
        _ => 3,
    };
    &args[n.min(args.len())..]
}

/// Where `name` is among options `o`, stepping over the words `--text` carries.
fn at(o: &[String], name: &str) -> Option<usize> {
    let mut i = 0;
    while i < o.len() {
        if o[i] == name {
            return Some(i);
        }
        i += if o[i] == "--text" { 2 } else { 1 };
    }
    None
}

/// `name`'s value among options `o`.
pub(crate) fn opt<'a>(o: &'a [String], name: &str) -> Option<&'a str> {
    at(o, name).and_then(|i| o.get(i + 1)).map(String::as_str)
}

/// Whether switch `name` is among options `o`.
pub(crate) fn has_opt(o: &[String], name: &str) -> bool {
    at(o, name).is_some()
}

/// `args` without the draft it carries, and without its chips unless `chips`: what runs, or with
/// its chips what's kept.
pub(super) fn bare(args: &[String], chips: bool) -> Vec<String> {
    let mut out = args[..args.len() - opts(args).len()].to_vec();
    let mut each = opts(args).iter();
    while let Some(a) = each.next() {
        match a.as_str() {
            "--draft" | "--draft-rev" => drop(each.next()),
            "--chips" if !chips => drop(each.next()),
            "--text" => out.extend([a].into_iter().chain(each.next()).cloned()),
            _ => out.push(a.clone()),
        }
    }
    out
}
