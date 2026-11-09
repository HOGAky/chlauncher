/**
 * @file rcon.js
 * Minimal Source RCON client (Valve server console protocol) — pure
 * `node:net`, no dependencies. One persistent connection with a
 * serialized request queue; reconnects + re-auths on drop.
 *
 * Packet: int32 size | int32 id | int32 type | body | \x00\x00
 * Types:  AUTH=3, AUTH_RESPONSE=2, EXECCOMMAND=2, RESPONSE_VALUE=0
 */

import net from 'node:net';

const SERVERDATA_RESPONSE_VALUE = 0;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

export class RconClient {
  /**
   * @param {{host?: string, port?: number, password: string}} opts
   */
  constructor({ host = '127.0.0.1', port = 25575, password }) {
    if (!password) throw new Error('rcon password required');
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.authed = false;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.queue = Promise.resolve();
  }

  /** Serialized entry point — commands go one at a time. */
  send(command) {
    const p = this.queue.then(() => this._sendNow(command));
    this.queue = p.catch(() => {});
    return p;
  }

  async _sendNow(command) {
    if (!this.socket || !this.authed) await this._connect();
    return this._request(SERVERDATA_EXECCOMMAND, command);
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.port, this.host);
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      const fail = (e) => {
        socket.destroy();
        this.socket = null;
        this.authed = false;
        for (const { reject: r } of this.pending.values()) r(e);
        this.pending.clear();
        reject(e);
      };
      socket.once('error', fail);
      socket.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        this._drain();
      });
      socket.on('close', () => {
        this.authed = false;
        this.socket = null;
        for (const { reject: r } of this.pending.values())
          r(new Error('rcon connection closed'));
        this.pending.clear();
      });
      socket.once('connect', async () => {
        socket.off('error', fail);
        try {
          // AUTH: wait for the type-2 AUTH_RESPONSE specifically (servers
          // also send a leading empty RESPONSE_VALUE); id=-1 = bad password.
          const auth = await this._request(
            SERVERDATA_AUTH,
            this.password,
            SERVERDATA_AUTH_RESPONSE
          );
          if (auth.id === -1) {
            socket.destroy();
            return reject(new Error('RCON_AUTH_FAILED'));
          }
          this.authed = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Sends one packet, resolves {id, body} when an answer of `wantType`
   * arrives (default RESPONSE_VALUE).
   */
  _request(type, body, wantType = SERVERDATA_RESPONSE_VALUE) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const bodyBuf = Buffer.from(body, 'utf8');
      const pkt = Buffer.alloc(14 + bodyBuf.length);
      pkt.writeInt32LE(10 + bodyBuf.length, 0); // size
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      bodyBuf.copy(pkt, 12);
      pkt.writeInt8(0, 12 + bodyBuf.length);
      pkt.writeInt8(0, 13 + bodyBuf.length);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('rcon timeout'));
      }, 10_000);
      this.pending.set(id, {
        wantType,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(pkt);
    });
  }

  /** Framing: full packets out of the receive buffer. */
  _drain() {
    for (;;) {
      if (this.buf.length < 14) return;
      const size = this.buf.readInt32LE(0);
      if (size < 10 || size > 4096) {
        this.socket.destroy();
        return;
      }
      if (this.buf.length < 4 + size) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.toString('utf8', 12, 12 + size - 10);
      this.buf = this.buf.subarray(4 + size);
      const p = this.pending.get(id);
      if (p && type === p.wantType) {
        this.pending.delete(id);
        p.resolve({ id, body });
      }
    }
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.authed = false;
  }
}
