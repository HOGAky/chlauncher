//! Integration test for the SDK side of the launcher protocol.
//!
//! A mock launcher is built in-test on a raw `TcpListener` +
//! `tungstenite::accept` — the same wire format the real launcher speaks
//! (`apps/launcher/src-tauri/src/game_ws.rs`):
//!   * `verify_with` sends `hello`, accepts `welcome` → `LauncherLink`;
//!   * bad token → `error` frame → `SdkError::Rejected`;
//!   * `event`/`shutdown` frames surface via `LauncherLink::poll`;
//!   * direct start without `--port/--token` → `SdkError::MissingArgs`.

use std::net::TcpListener;
use std::thread;
use tiktok_game_sdk::{init_and_verify, verify_with, LauncherMessage, SdkError};
use tungstenite::Message;

/// Starts a mock launcher on an ephemeral port; returns (port, join handle).
/// `responder` decides the first reply after reading the hello token.
fn mock_launcher<F>(responder: F) -> u16
where
    F: Fn(&str) -> &'static str + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        // read hello
        let Message::Text(hello) = ws.read().unwrap() else {
            panic!("expected hello");
        };
        let v: serde_json::Value = serde_json::from_str(&hello).unwrap();
        let reply = responder(v["token"].as_str().unwrap_or(""));
        ws.send(Message::Text(reply.into())).unwrap();
        if reply.contains("welcome") {
            // one event then shutdown
            ws.send(Message::Text(
                r#"{"type":"event","event":{"source":"simulator","event_kind":"gift","user":"tester","avatar_url":"","action_command":"spawn_enemy","amount":2,"raw_name":"Rose"}}"#
                    .into(),
            ))
            .unwrap();
            ws.send(Message::Text(
                r#"{"type":"heartbeat","ts":9999999999}"#.into(),
            ))
            .unwrap();
            ws.send(Message::Text(r#"{"type":"shutdown"}"#.into()))
                .unwrap();
            // keep the socket open briefly so reads complete
            thread::sleep(std::time::Duration::from_millis(200));
        }
    });
    port
}

#[test]
fn hello_welcome_event_shutdown() {
    let port = mock_launcher(|token| {
        assert_eq!(token, "good-token");
        r#"{"type":"welcome","protocol":1}"#
    });
    let link = verify_with(port, "good-token").expect("handshake must succeed");

    // Drain: should contain the event then shutdown (heartbeat is consumed
    // internally by the watchdog, never queued).
    let mut got_event = false;
    let mut got_shutdown = false;
    for _ in 0..50 {
        for msg in link.poll() {
            match msg {
                LauncherMessage::Event { event } => {
                    assert_eq!(event.action_command, "spawn_enemy");
                    assert_eq!(event.user, "tester");
                    got_event = true;
                }
                LauncherMessage::Shutdown => got_shutdown = true,
                _ => {}
            }
        }
        if got_event && got_shutdown {
            break;
        }
        thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(got_event, "expected an event frame");
    assert!(got_shutdown, "expected a shutdown frame");
}

#[test]
fn invalid_token_is_rejected() {
    let port = mock_launcher(|_| r#"{"type":"error","reason":"invalid token"}"#);
    match verify_with(port, "bogus") {
        Err(SdkError::Rejected(r)) => assert_eq!(r, "invalid token"),
        other => panic!("expected Rejected, got {other:?}"),
    }
}

#[test]
fn direct_launch_missing_args() {
    // The test harness argv contains no --port/--token → MissingArgs.
    match init_and_verify() {
        Err(SdkError::MissingArgs) => {}
        other => panic!("expected MissingArgs, got {other:?}"),
    }
}
