//! Console-command templates for trigger rules (§9.3).
//!
//! A rule's `action` is the command template itself:
//! `summon zombie ~ ~ ~` or `give {player} diamond {count}`. Placeholders:
//! `{player}` (settings target, `@a` when unset), `{user}` (viewer nick),
//! `{count}`/`{amount}` (event amount), `{gift}` (matched item name).
//! Multiple commands in one template split on `\n`.
//!
//! **Injection safety**: viewer-controlled values (`{user}`, `{gift}`)
//! pass through [`sanitize`] — a nickname like `x\nop @a` or `a"kill @a`
//! must never reach the console. Anything outside `[A-Za-z0-9_.-]` is
//! dropped (no spaces → no argument smuggling, no `§` colour codes, no
//! newlines → no extra commands).

use crate::types::StreamEvent;

/// Strips a value to console-safe characters (max 48).
pub fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(48)
        .collect()
}

/// The configured `{player}` target — a username or a selector like
/// `@a`/`@p[name=x]`; selector syntax chars are kept, everything else
/// follows [`sanitize`].
pub fn sanitize_player(s: &str) -> String {
    s.chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '.' | '-' | '@' | '[' | ']' | '=' | ',' | '!')
        })
        .take(48)
        .collect()
}

/// Renders one template line with the event context.
pub fn render(template: &str, user: &str, player: &str, amount: i32, gift: &str) -> String {
    let target = if player.trim().is_empty() {
        "@a".to_string()
    } else {
        sanitize_player(player)
    };
    template
        .replace("{player}", &target)
        .replace("{user}", &sanitize(user))
        .replace("{count}", &amount.to_string())
        .replace("{amount}", &amount.to_string())
        .replace("{gift}", &sanitize(gift))
}

/// Renders an event's `action_command` into executable console lines —
/// one per `\n`, empty lines dropped.
pub fn render_event(action_command: &str, ev: &StreamEvent, player: &str) -> Vec<String> {
    action_command
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| render(l, &ev.user, player, ev.amount, &ev.raw_name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_injection_vectors() {
        assert_eq!(sanitize("x\nop @a"), "xopa");
        assert_eq!(sanitize(r#"a"kill @a"#), "akilla");
        assert_eq!(sanitize("§cgriefer"), "cgriefer");
        assert_eq!(sanitize("Steve_42"), "Steve_42");
        // spaces gone — can't smuggle extra args
        assert_eq!(sanitize("a b"), "ab");
    }

    #[test]
    fn render_fills_all_placeholders() {
        let out = render(
            "give {player} diamond {count} say {user} sent {gift}",
            "evil\nop @a",
            "Steve",
            5,
            "Rose Box",
        );
        assert_eq!(out, "give Steve diamond 5 say evilopa sent RoseBox");
    }

    #[test]
    fn empty_player_defaults_to_all() {
        assert_eq!(
            render("effect give {player} speed 5", "", " ", 1, ""),
            "effect give @a speed 5"
        );
    }

    #[test]
    fn render_event_splits_lines() {
        let ev = StreamEvent {
            source: "tiktok".into(),
            event_kind: "gift".into(),
            user: "v_1".into(),
            avatar_url: String::new(),
            action_command: String::new(),
            amount: 3,
            raw_name: "Rose".into(),
            event_id: String::new(),
        };
        let lines = render_event(
            "say hi {user}\n\n  give {player} rose {count}  ",
            &ev,
            "Bob",
        );
        assert_eq!(lines, vec!["say hi v_1", "give Bob rose 3"]);
    }
}
