import {Database} from "bun:sqlite";
import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";
import {mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync, openSync, fsyncSync, closeSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

const MAGIC = Buffer.from("MAPAE-BACKUP-1\n");
function keyFrom(path: string): Buffer {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Key file must be private (chmod 600).");
    const key = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Expected a 32-byte hex key file.");
    return Buffer.from(key, "hex");
}
function inspect(path: string) {
    const db = new Database(path, {readonly: true, strict: true});
    try {
        if (Object.values(db.query("PRAGMA integrity_check").get() ?? {})[0] !== "ok") throw new Error("Backup integrity check failed.");
        if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup foreign key check failed.");
        const schema = Object.values(db.query("PRAGMA user_version").get() ?? {})[0];
        const tables = db.query<{name: string}, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(v => v.name);
        return {schema, tables};
    } finally {db.close();}
}
/** VACUUM INTO includes committed WAL pages in one consistent SQLite snapshot. */
export function backup(source: string, destination: string, keyPath: string) {
    const key = keyFrom(keyPath), directory = mkdtempSync(join(tmpdir(), "mapae-backup-"));
    chmodSync(directory, 0o700);
    try {
        const snapshot = join(directory, "snapshot.sqlite");
        const db = new Database(source, {readonly: true, strict: true});
        try {db.exec("PRAGMA busy_timeout=5000"); db.query("VACUUM INTO ?").run(snapshot);} finally {db.close();}
        const details = inspect(snapshot), bytes = readFileSync(snapshot);
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(MAGIC);
        const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
        writeFileSync(destination, Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]), {flag: "wx", mode: 0o600});
        const fd = openSync(destination, "r"); try {fsyncSync(fd);} finally {closeSync(fd);}
        return {ok: true, createdAt: new Date().toISOString(), file: resolve(destination), bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"), ...details};
    } finally {key.fill(0); rmSync(directory, {recursive: true, force: true});}
}
/** A drill NEVER replaces an active database. Authenticated decryption precedes SQLite. */
export function restoreDrill(source: string, keyPath: string, destination?: string) {
    const start = Date.now(), key = keyFrom(keyPath), bytes = readFileSync(source);
    const directory = mkdtempSync(join(tmpdir(), "mapae-restore-drill-")); chmodSync(directory, 0o700);
    try {
        if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid backup format.");
        const at = MAGIC.length, decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(at, at + 12));
        decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(at + 12, at + 28));
        const plain = Buffer.concat([decipher.update(bytes.subarray(at + 28)), decipher.final()]);
        const restored = join(directory, "restored.sqlite"); writeFileSync(restored, plain, {flag: "wx", mode: 0o600});
        const details = inspect(restored);
        if (destination) {
            writeFileSync(destination, plain, {flag: "wx", mode: 0o600});
            const fd = openSync(destination, "r"); try {fsyncSync(fd);} finally {closeSync(fd);}
        }
        return {ok: true, ...details, ...(destination ? {restoredFile: resolve(destination)} : {}), sha256: createHash("sha256").update(plain).digest("hex"), elapsedMs: Date.now() - start};
    } finally {key.fill(0); rmSync(directory, {recursive: true, force: true});}
}
if (import.meta.main) {
    const [command, source, destination, key] = process.argv.slice(2);
    try {
        if (command === "backup" && source && destination && key) console.log(JSON.stringify(backup(source, destination, key), null, 2));
        else if (command === "restore" && source && destination && key) console.log(JSON.stringify(restoreDrill(source, key, destination), null, 2));
        else if (command === "drill" && source && destination && !key) console.log(JSON.stringify(restoreDrill(source, destination), null, 2));
        else throw new Error("Usage: bun scripts/ops/backup.ts backup DB ENCRYPTED_FILE KEY_FILE | drill ENCRYPTED_FILE KEY_FILE | restore ENCRYPTED_FILE NEW_DB_FILE KEY_FILE");
    } catch {console.error("Backup/drill failed; no active database was replaced. Check paths, private key-file permissions and database integrity."); process.exitCode = 1;}
}
