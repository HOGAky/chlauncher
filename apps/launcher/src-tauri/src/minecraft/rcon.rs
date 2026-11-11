//! Minimal Source RCON client (Valve server console protocol) — a Rust
//! port of `tools/mc-bridge/rcon.js`. One connection per call: connect →
//! AUTH → EXECCOMMAND → read response → close. Per-call connections keep
//! error handling trivial (no stale auth state to manage) and Minecraft
//! happily accepts concurrent RCON clients.
//!
//! Packet: `int32 size | int32 id | int32 type | body | \x00 \x00`
//! Types:  AUTH=3, AUTH_RESPONSE=2, EXECCOMMAND=2, RESPONSE_VALUE=0

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};

const RESPONSE_VALUE: i32 = 0;
const AUTH_RESPONSE: i32 = 2;
const AUTH: i32 = 3;
const EXECCOMMAND: i32 = 2;
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Executes one console command over RCON, returns the response body
/// (trimmed — often empty for commands like `give`).
pub async fn exec(host: &str, port: u16, password: &str, command: &str) -> Result<String, String> {
    let mut io = timeout(IO_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "RCON_TIMEOUT".to_string())?
        .map_err(|e| format!("RCON_CONNECT: {e}"))?;

    // --- AUTH ------------------------------------------------------------
    write_packet(&mut io, 1, AUTH, password).await?;
    // Servers may prepend an empty RESPONSE_VALUE; wait for type-2.
    // `buf` persists across packets — TCP coalescing can deliver two
    // frames in one read and the tail must survive to the next parse.
    let mut buf = Vec::with_capacity(512);
    let mut auth_ok = false;
    for _ in 0..4 {
        let (id, ty, _body) = read_packet(&mut io, &mut buf).await?;
        if ty == AUTH_RESPONSE {
            if id == -1 {
                return Err("RCON_AUTH_FAILED".into());
            }
            auth_ok = true;
            break;
        }
    }
    if !auth_ok {
        return Err("RCON_AUTH_FAILED".into());
    }

    // --- EXECCOMMAND -----------------------------------------------------
    write_packet(&mut io, 2, EXECCOMMAND, command).await?;
    for _ in 0..4 {
        let (id, ty, body) = read_packet(&mut io, &mut buf).await?;
        if ty == RESPONSE_VALUE && id == 2 {
            return Ok(body.trim().to_string());
        }
    }
    Ok(String::new())
}

async fn write_packet(io: &mut TcpStream, id: i32, ty: i32, body: &str) -> Result<(), String> {
    let body = body.as_bytes();
    let mut pkt = Vec::with_capacity(14 + body.len());
    pkt.extend_from_slice(&(10 + body.len() as i32).to_le_bytes());
    pkt.extend_from_slice(&id.to_le_bytes());
    pkt.extend_from_slice(&ty.to_le_bytes());
    pkt.extend_from_slice(body);
    pkt.extend_from_slice(&[0, 0]);
    timeout(IO_TIMEOUT, io.write_all(&pkt))
        .await
        .map_err(|_| "RCON_TIMEOUT".to_string())?
        .map_err(|e| format!("RCON_WRITE: {e}"))
}

/// Reads one framed packet → `(id, type, body)`. The MC server sends
/// packets whole, but TCP can split anywhere — loop until 14+ bytes and
/// the declared size have arrived. `buf` is caller-owned: bytes beyond
/// the consumed packet are left in it for the next call (pipelined
/// frames would otherwise be silently dropped → spurious timeouts).
async fn read_packet<R: AsyncRead + Unpin>(
    io: &mut R,
    buf: &mut Vec<u8>,
) -> Result<(i32, i32, String), String> {
    loop {
        if buf.len() >= 14 {
            let size = i32::from_le_bytes(buf[0..4].try_into().unwrap());
            if !(10..=65_536).contains(&size) {
                return Err("RCON_FRAME".into());
            }
            if buf.len() >= 4 + size as usize {
                let id = i32::from_le_bytes(buf[4..8].try_into().unwrap());
                let ty = i32::from_le_bytes(buf[8..12].try_into().unwrap());
                let body = String::from_utf8_lossy(&buf[12..2 + size as usize]).into_owned();
                buf.drain(..4 + size as usize);
                return Ok((id, ty, body));
            }
        }
        let n = timeout(IO_TIMEOUT, io.read_buf(buf))
            .await
            .map_err(|_| "RCON_TIMEOUT".to_string())?
            .map_err(|e| format!("RCON_READ: {e}"))?;
        if n == 0 {
            return Err("RCON_CLOSED".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: i32, ty: i32, body: &str) -> Vec<u8> {
        let b = body.as_bytes();
        let mut pkt = Vec::new();
        pkt.extend_from_slice(&(10 + b.len() as i32).to_le_bytes());
        pkt.extend_from_slice(&id.to_le_bytes());
        pkt.extend_from_slice(&ty.to_le_bytes());
        pkt.extend_from_slice(b);
        pkt.extend_from_slice(&[0, 0]);
        pkt
    }

    #[tokio::test]
    async fn pipelined_packets_in_one_read_both_parse() {
        // Two frames coalesced into a single TCP segment — the second
        // must not be lost when the first is consumed (auth flakiness
        // regression: empty RESPONSE_VALUE + AUTH_RESPONSE in one read).
        let (mut a, mut b) = tokio::io::duplex(256);
        let mut wire = frame(7, RESPONSE_VALUE, "");
        wire.extend(frame(1, AUTH_RESPONSE, ""));
        tokio::io::AsyncWriteExt::write_all(&mut a, &wire)
            .await
            .unwrap();
        drop(a);

        let mut buf = Vec::new();
        let (id1, ty1, _) = read_packet(&mut b, &mut buf).await.unwrap();
        let (id2, ty2, _) = read_packet(&mut b, &mut buf).await.unwrap();
        assert_eq!((id1, ty1), (7, RESPONSE_VALUE));
        assert_eq!((id2, ty2), (1, AUTH_RESPONSE));
    }

    #[tokio::test]
    async fn split_packet_waits_for_tail() {
        // First half arrives, second half later — read_packet must loop.
        let (mut a, mut b) = tokio::io::duplex(64);
        let wire = frame(2, RESPONSE_VALUE, "hello");
        let mid = wire.len() / 2;
        tokio::io::AsyncWriteExt::write_all(&mut a, &wire[..mid])
            .await
            .unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut a, &wire[mid..])
            .await
            .unwrap();
        drop(a);

        let mut buf = Vec::new();
        let (id, ty, body) = read_packet(&mut b, &mut buf).await.unwrap();
        assert_eq!((id, ty, body.as_str()), (2, RESPONSE_VALUE, "hello"));
    }

    #[test]
    fn packet_layout_matches_source_rcon() {
        // size covers id+type+body+2 nulls → 10 + body_len
        let body = b"abc";
        let size = 10 + body.len() as i32;
        assert_eq!(size, 13);
    }
}
