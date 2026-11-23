//! Reading a shell command as a thread step, after the old app's rules [D48, D65].

/// The step a shell command is and what it acts on, by what its programs do [D48, D65, D116]: its
/// first program that runs something (`cargo build > log`) runs, or that writes a file (`sed -i`,
/// `tee`, `echo x > f`, `mv`, `rm` …) edits it; with neither, one that reads, searches or lists
/// (`cd x && rg …`, `sed -n 1,80p a | head`) is that, by its first. A pipe's later programs only
/// filter; a plain GET of a public page is web. Shell wrappers and leading `cd … &&` go first.
pub fn shell_step(command: &str) -> (&'static str, String) {
    let command = unwrap_shell(command);
    // The thread's own `brigadier start|wait|queue|send|stop` is no row: its start, message or end has its own, as
    // in the old thread [D47, D3044].
    let mut call = command.split_whitespace();
    if call.next().is_some_and(|w| basename(w) == "brigadier")
        && call
            .next()
            .is_some_and(|sub| matches!(sub, "start" | "wait" | "queue" | "send" | "stop"))
    {
        return ("", String::new());
    }
    // The first program that runs or edits says what the line does; else the first that reads, searches or lists.
    let mut first = None;
    for part in parts(&command) {
        let words = words(&part.text);
        let step = match step_of(program_words(&words), part.piped) {
            Some(("run", _)) => return ("run", command),
            Some(("edit", file)) => Some(("edit", file)),
            _ if !part.writes.is_empty() => Some(("edit", part.writes.into_iter().next())),
            step => step,
        };
        match step {
            Some(("edit", file)) => {
                return (
                    "edit",
                    file.or_else(|| patched(&command)).unwrap_or(command),
                );
            }
            Some(step) => {
                first.get_or_insert(step);
            }
            None => {}
        }
    }
    match first {
        Some((step, what)) => (step, what.unwrap_or(command)),
        None => ("run", command),
    }
}

/// A program's words without what only wraps it: `FOO=1`, `sudo`, `env`, `time`, `nohup`, `timeout 30`.
fn program_words(words: &[String]) -> &[String] {
    let mut at = 0;
    while let Some(w) = words.get(at) {
        let assigns = w.contains('=') && !w.starts_with(['-', '=']);
        match w.as_str() {
            "sudo" | "env" | "time" | "nohup" | "command" | "exec" | "nice" => at += 1,
            "timeout" => at += 2,
            _ if assigns => at += 1,
            _ => break,
        }
    }
    &words[at.min(words.len())..]
}

/// The file an `apply_patch` heredoc changes, from its first file line.
fn patched(command: &str) -> Option<String> {
    command.lines().find_map(|l| {
        ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
            .iter()
            .find_map(|p| l.trim().strip_prefix(p))
            .map(String::from)
    })
}

/// One program's step and what it acts on (None: the whole command); None when it does nothing to
/// speak of (`cd`, `echo`) or, `piped`, only filters what came before.
fn step_of(words: &[String], piped: bool) -> Option<(&'static str, Option<String>)> {
    let program = basename(words.first()?);
    let rest = || words.iter().skip(1).map(String::as_str);
    let args = || rest().filter(|w| !w.starts_with('-'));
    let path = rest()
        .rfind(|w| !w.starts_with('-') && !w.starts_with(|c: char| c.is_ascii_digit()))
        .map(String::from);
    let flagged =
        |f: char| rest().any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains(f));
    if piped {
        return match program {
            "tee" => args().next().map(|f| ("edit", Some(f.to_string()))),
            _ => None,
        };
    }
    let sends = |w: &str| {
        let w = w.split('=').next().unwrap_or("");
        matches!(
            w,
            "-X" | "--request"
                | "-d"
                | "-F"
                | "-T"
                | "--upload-file"
                | "--post-data"
                | "--post-file"
                | "--method"
                | "--body-data"
                | "--body-file"
        ) || w.starts_with("--data")
            || w.starts_with("--form")
    };
    if matches!(program, "curl" | "wget") && !rest().any(sends) {
        let urls: Vec<&str> = rest()
            .filter(|w| w.starts_with("http://") || w.starts_with("https://"))
            .collect();
        if !urls.is_empty() && urls.iter().all(|u| public_host(u)) {
            return Some(("web", Some(urls[0].to_string())));
        }
    }
    let search = |args: &[String]| Some(("search", pattern(args).map(String::from)));
    let sub = words.get(1).map(String::as_str);
    // Asking a program what it is or does only reads: `x --help`, `x --version`, `git help log`, `man x` [D291].
    if program == "man"
        || sub == Some("help")
        || rest().any(|w| w == "--help")
        || rest().eq(["--version"])
    {
        return Some(("read", None));
    }
    Some(match program {
        // The thread's own look-ups only read: `brigadier models`, `brigadier read <id>` [D291].
        "brigadier"
            if matches!(
                sub,
                Some("models" | "sessions" | "read" | "notes" | "skill")
            ) =>
        {
            ("read", None)
        }
        "brigadier" if sub == Some("search") => return search(&words[2..]),
        "cd" | "pushd" | "popd" | "echo" | "printf" | "true" | "false" | "pwd" | "export"
        | "set" | "unset" | "source" | "." | ":" | "which" | "type" => return None,
        "sed" if flagged('i') || rest().any(|w| w.starts_with("--in-place")) => ("edit", path),
        "perl" if flagged('i') => ("edit", path),
        "tee" => ("edit", args().next().map(String::from)),
        "apply_patch" | "patch" | "mv" | "cp" | "rm" | "rmdir" | "mkdir" | "touch" | "ln"
        | "truncate" => ("edit", path),
        "git" if words.get(1).is_some_and(|w| w == "apply") => ("edit", None),
        "cat" | "head" | "tail" | "nl" | "less" | "more" | "bat" | "wc" | "sed" => match path {
            Some(p) => ("read", Some(p)),
            None => ("run", None),
        },
        "ls" | "tree" | "eza" | "exa" => ("list", path),
        "git" if words.get(1).is_some_and(|w| w == "ls-files") => ("list", None),
        "find" | "fd" => ("search", path),
        "rg" if rest().any(|w| w == "--files") => ("search", None),
        "rg" | "grep" | "egrep" | "fgrep" | "ag" | "ack" => return search(&words[1..]),
        "git" if words.get(1).is_some_and(|w| w == "grep") => return search(&words[2..]),
        _ => ("run", None),
    })
}

/// One program of a command line, its output redirects to files taken out as what it writes.
#[derive(Default)]
struct Part {
    text: String,
    /// Behind a `|`: it filters what came before.
    piped: bool,
    writes: Vec<String>,
}

/// A command line's programs, split at `|`, `&&`, `||`, `;`, `&` and newlines outside quotes and
/// parentheses; a heredoc's body is left out.
fn parts(command: &str) -> Vec<Part> {
    let mut out = vec![Part::default()];
    let mut heredoc: Option<String> = None;
    let mut depth = 0u32;
    let mut chars = command.chars().peekable();
    // A word as written, up to a blank or an operator, its quotes kept.
    let word = |chars: &mut std::iter::Peekable<std::str::Chars>| {
        while chars.next_if(|c| *c == ' ' || *c == '\t').is_some() {}
        let mut w = String::new();
        while let Some(c) = chars.next_if(|c| !c.is_whitespace() && !"|&;<>()".contains(*c)) {
            w.push(c);
        }
        w
    };
    while let Some(c) = chars.next() {
        let part = out.last_mut().expect("one part at least");
        match c {
            '\'' | '"' => {
                part.text.push(c);
                while let Some(n) = chars.next() {
                    part.text.push(n);
                    if n == '\\' && c == '"' {
                        part.text.extend(chars.next());
                    } else if n == c {
                        break;
                    }
                }
            }
            '\\' => {
                part.text.push(c);
                part.text.extend(chars.next());
            }
            '(' => {
                depth += 1;
                part.text.push(c);
            }
            ')' => {
                depth = depth.saturating_sub(1);
                part.text.push(c);
            }
            _ if depth > 0 => part.text.push(c),
            '>' | '&' if c == '>' || chars.peek() == Some(&'>') => {
                if c == '&' {
                    chars.next();
                }
                // `2>`: its descriptor goes with it.
                let digits = part.text.len()
                    - part
                        .text
                        .trim_end_matches(|d: char| d.is_ascii_digit())
                        .len();
                if digits > 0 && part.text[..part.text.len() - digits].ends_with([' ', '\t']) {
                    part.text.truncate(part.text.len() - digits);
                }
                chars.next_if(|n| *n == '>' || *n == '|');
                while chars.next_if(|c| *c == ' ' || *c == '\t').is_some() {}
                if chars.next_if(|n| *n == '&').is_some() {
                    word(&mut chars);
                    continue;
                }
                let file = words(&word(&mut chars))
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                if !file.is_empty() && !file.starts_with("/dev/") {
                    part.writes.push(file);
                }
            }
            '<' => {
                if chars.next_if(|n| *n == '<').is_some() {
                    // A here-string's word; a heredoc's body from the next line to its delimiter.
                    if chars.next_if(|n| *n == '<').is_some() {
                        word(&mut chars);
                        continue;
                    }
                    chars.next_if(|n| *n == '-');
                    heredoc = words(&word(&mut chars)).into_iter().next();
                } else {
                    chars.next_if(|n| *n == '(');
                    word(&mut chars);
                }
            }
            '\n' if heredoc.is_some() => {
                let end = heredoc.take().unwrap_or_default();
                loop {
                    let line: String = chars.by_ref().take_while(|c| *c != '\n').collect();
                    if line.trim() == end || chars.peek().is_none() {
                        break;
                    }
                }
                out.push(Part::default());
            }
            '|' | '&' | ';' | '\n' => {
                let piped = c == '|' && chars.next_if(|n| *n == '|').is_none();
                if c == '&' {
                    chars.next_if(|n| *n == '&');
                }
                chars.next_if(|n| piped && *n == '&');
                out.push(Part {
                    piped,
                    ..Part::default()
                });
            }
            c => part.text.push(c),
        }
    }
    out
}
/// A call through the relay, `brigadier mcp call <server> <tool> ['<json>']`, as its server, tool
/// and arguments, so a worker's plugin call reads as the lead's own does [D567, D768]. Its output's
/// redirects and pipes (`2>&1 | head`) are left out; a line that runs anything else isn't one.
pub fn relay_call(command: &str) -> Option<(String, String, String)> {
    let words = words(&unwrap_shell(command));
    let chained = |w: &String| matches!(w.as_str(), "&&" | "||" | ";" | "&") || w.ends_with(';');
    if command.contains('\n') || words.iter().any(chained) {
        return None;
    }
    let mut w = (words.iter().map(String::as_str)).take_while(|w| {
        let redirect = w
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .starts_with('>');
        *w != "|" && !redirect
    });
    let head = [w.next()?, w.next()?, w.next()?];
    if basename(head[0]) != "brigadier" || head[1..] != ["mcp", "call"] {
        return None;
    }
    let (server, tool) = (w.next()?, w.next()?);
    let args = w.next().filter(|a| !a.starts_with('-')).unwrap_or("{}");
    Some((server.into(), tool.into(), args.into()))
}

/// A search's pattern: its `-e` value, else its first word that is neither an option nor an
/// option's value.
fn pattern(args: &[String]) -> Option<&str> {
    let mut args = args.iter().map(String::as_str);
    while let Some(w) = args.next() {
        match w {
            "-e" | "--regexp" => return args.next(),
            "-g" | "--glob" | "--iglob" | "-t" | "--type" | "-T" | "--type-not" | "-m"
            | "--max-count" | "-A" | "-B" | "-C" | "--after-context" | "--before-context"
            | "--context" | "-d" | "--max-depth" | "-f" | "--file" | "--include" | "--exclude"
            | "-M" | "--max-columns" | "-j" | "--threads" => {
                args.next();
            }
            w if w.starts_with('-') => {}
            w => return Some(w),
        }
    }
    None
}

/// `/bin/zsh -lc 'wc -l a.py'` and `cd /tmp/x && wc -l a.py` → `wc -l a.py`.
pub fn unwrap_shell(command: &str) -> String {
    let mut c = command.trim().to_string();
    if let Some((program, rest)) = c.split_once(char::is_whitespace)
        && matches!(basename(program), "sh" | "bash" | "zsh")
        && let Some(body) = rest
            .trim_start()
            .strip_prefix("-lc")
            .or_else(|| rest.trim_start().strip_prefix("-c"))
            .filter(|b| b.starts_with(char::is_whitespace))
    {
        // The script is the shell's next word, its quotes undone as the shell would.
        c = words(body).into_iter().next().unwrap_or_default();
    }
    let mut c = c.trim();
    while let Some(rest) = c.strip_prefix("cd ") {
        let rest = rest.trim_start();
        let arg_end = match rest.chars().next() {
            Some(q @ ('\'' | '"')) => rest[1..].find(q).map(|i| i + 2),
            _ => rest.find(char::is_whitespace),
        };
        match arg_end.and_then(|i| rest[i..].trim_start().strip_prefix("&&")) {
            Some(next) => c = next.trim_start(),
            None => break,
        }
    }
    c.to_string()
}

/// A simple command's words, quotes and backslashes undone as the shell does; an unclosed quote
/// runs to the end.
fn words(command: &str) -> Vec<String> {
    let mut out = vec![];
    let mut chars = command.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        if chars.peek().is_none() {
            return out;
        }
        let mut word = String::new();
        while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
            match c {
                '\'' => word.extend(chars.by_ref().take_while(|&c| c != '\'')),
                '"' => {
                    while let Some(c) = chars.next().filter(|&c| c != '"') {
                        match chars.next_if(|&n| c == '\\' && matches!(n, '"' | '\\' | '$' | '`')) {
                            Some(n) => word.push(n),
                            None => word.push(c),
                        }
                    }
                }
                '\\' => word.extend(chars.next()),
                c => word.push(c),
            }
        }
        out.push(word);
    }
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// A host on the internet, not this machine or the local network.
fn public_host(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = host
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let private = ["127.", "10.", "192.168.", "169.254.", "0."]
        .iter()
        .any(|p| host.starts_with(p))
        || (16..32).any(|n| host.starts_with(&format!("172.{n}.")));
    host.contains('.')
        && !host.ends_with(".local")
        && !host.ends_with(".internal")
        && !private
        && !host.starts_with('[')
}
