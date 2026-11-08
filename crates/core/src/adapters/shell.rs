//! Reading a shell command as a thread step, after the old app's rules [D48, D65].

/// The step a shell command is and what it acts on, after the old app's rules [D48, D65]: a
/// compound command runs; a plain GET of a public page is web; readers with a path read; listers
/// and searchers search. Shell wrappers and leading `cd … &&` are taken off first.
pub fn shell_step(command: &str) -> (&'static str, String) {
    let command = unwrap_shell(command);
    let probe = command.split(" || ").next().unwrap_or("");
    if probe.contains([';', '&', '|', '<', '>', '`', '$', '(']) {
        return ("run", command);
    }
    let words = words(&command);
    let program = words.first().map_or("", |w| basename(w));
    let rest = || words.iter().skip(1).map(String::as_str);
    let path = rest()
        .rfind(|w| !w.starts_with('-') && !w.starts_with(|c: char| c.is_ascii_digit()))
        .map(String::from);
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
            return ("web", urls[0].to_string());
        }
    }
    match program {
        "rg" if rest().any(|w| w == "--files") => ("search", command),
        "cat" | "head" | "tail" | "nl" | "less" | "more" | "bat" | "wc" | "sed" => match path {
            Some(p) => ("read", p),
            None => ("run", command),
        },
        "ls" | "find" | "tree" | "fd" => ("search", path.unwrap_or(command)),
        "rg" | "grep" | "ag" | "ack" => match pattern(&words[1..]) {
            Some(pattern) => ("search", pattern.to_string()),
            None => ("search", command),
        },
        _ => ("run", command),
    }
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
