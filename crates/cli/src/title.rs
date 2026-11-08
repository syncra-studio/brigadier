//! A session's short local title from its first message, the old app's rule [D186].

const TITLE_WORDS: usize = 5;
const TITLE_CHARS: usize = 36;
const MAX_NAME_CHARS: usize = 200;

/// Words a request opens with that name nothing: "Please start the build" is titled
/// "Start the build".
const OPENERS: &[&str] = &[
    "i would like you to",
    "i'd like you to",
    "i want you to",
    "i need you to",
    "can you please",
    "could you please",
    "can you",
    "could you",
    "would you",
    "will you",
    "can u",
    "let's",
    "lets",
    "let us",
    "please",
    "pls",
    "hey",
    "hi",
    "hello",
    "ok",
    "okay",
    "so",
    "also",
];

/// Words a cut title doesn't end on.
const DANGLING: &[&str] = &[
    "a", "an", "the", "to", "from", "of", "for", "with", "in", "on", "at", "by", "into", "and",
    "or", "but", "that", "this", "my", "our", "your", "its", "is", "are",
];

/// The title of a session whose first message is `text`: its short title, else its start on one line.
pub fn from(text: &str) -> String {
    let title = short(text);
    if title.is_empty() {
        one_line(text, TITLE_CHARS)
    } else {
        title
    }
}

/// A name the user typed, its whitespace collapsed: not empty, at most 200 characters.
pub fn clean(name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Title can't be empty.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "Title can't be longer than {MAX_NAME_CHARS} characters."
        ));
    }
    Ok(name)
}

/// A few plain words naming what `text` asks, from its first line's first sentence, without a
/// polite opener ("Please …", "Can you …") or a closing stop: "Please start the nightly build
/// from the main branch" reads "Start the nightly build". At most `TITLE_WORDS` words and
/// `TITLE_CHARS` characters; empty for a blank text.
fn short(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return line;
    }
    let mut rest = line.as_str();
    let mut opened = false;
    'strip: loop {
        for opener in OPENERS {
            let Some(after) = rest
                .get(..opener.len())
                .filter(|head| head.eq_ignore_ascii_case(opener))
                .map(|_| &rest[opener.len()..])
            else {
                continue;
            };
            // Only a whole opener ("so", not "some"), with its comma or stop.
            let tail = after.trim_start_matches([',', '.', '!', ':']);
            if !tail.is_empty() && !tail.starts_with(' ') {
                continue;
            }
            let stripped = tail.trim_start();
            if stripped.is_empty() {
                break 'strip;
            }
            rest = stripped;
            opened = true;
            continue 'strip;
        }
        break;
    }
    // Its first sentence or clause.
    let sentence = [". ", "? ", "! ", ": ", "; "]
        .iter()
        .filter_map(|stop| rest.find(stop))
        .min()
        .filter(|&at| at > 0)
        .map_or(rest, |at| &rest[..at]);
    let words: Vec<&str> = sentence
        .split(' ')
        .filter(|word| !word.is_empty())
        .collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut chars = 0;
    for word in &words {
        let more = word.chars().count() + usize::from(!kept.is_empty());
        if kept.len() == TITLE_WORDS || chars + more > TITLE_CHARS {
            break;
        }
        kept.push(word);
        chars += more;
    }
    if kept.len() < words.len() {
        while kept.len() > 1
            && kept
                .last()
                .is_some_and(|word| DANGLING.contains(&word.to_lowercase().as_str()))
        {
            kept.pop();
        }
    }
    let mut title = if kept.is_empty() {
        // One word longer than a title (a long path, or a script without spaces).
        let mut cut: String = sentence.chars().take(TITLE_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        kept.join(" ")
            .trim_end_matches(['.', ',', ';', ':', '!', '?', '…'])
            .to_owned()
    };
    if opened && let Some(first) = title.chars().next() {
        title = first.to_uppercase().chain(title.chars().skip(1)).collect();
    }
    title
}

/// `text` with its whitespace collapsed, cut to `chars` characters (with an ellipsis).
fn one_line(text: &str, chars: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= chars {
        line
    } else {
        let mut cut: String = line.chars().take(chars - 1).collect();
        cut.push('…');
        cut
    }
}
