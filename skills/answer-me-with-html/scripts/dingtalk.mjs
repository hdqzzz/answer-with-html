// Optional self-delivery for this edition. Authentication stays in dws; only preferences and receipts live here.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const SCRIPT = fileURLToPath(import.meta.url);
const FORMATS = ['html', 'pdf', 'png', 'both'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const homePath = () => process.env.AM_HOME || join(homedir(), '.answer-me-with-html');
const configPath = (home) => join(home, 'dingtalk.json');

function save(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function settings(home = homePath()) {
  const config = existsSync(configPath(home)) ? json(configPath(home)) : {};
  const format = config.format || 'html';
  if (!FORMATS.includes(format)) throw new Error(`Choose a DingTalk format: ${FORMATS.join(' | ')}`);
  return { enabled: config.enabled === true, format, profile: config.profile, corpId: config.corpId, userId: config.userId };
}

export function runDws(args, options = {}) {
  let result;
  try {
    result = JSON.parse(execFileSync('dws', [...args, '--format', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000, ...options,
    }));
  } catch {
    // Do not echo CLI payloads or credentials; an interrupted write is not proof that nothing was sent.
    throw new Error('DingTalk command did not return a verified result. Check local dws authorization and the saved receipt.');
  }
  if (result.success === false) throw new Error('DingTalk rejected the operation. Check local dws authorization and permissions.');
  return result;
}

async function self(profile, dws) {
  const data = await dws(['contact', 'user', 'get-self', '--profile', profile]);
  const people = data.result;
  const person = Array.isArray(people) && people.length === 1 ? people[0].orgEmployeeModel : null;
  if (!person?.corpId || !person.userId) throw new Error('DingTalk did not identify one current user. Nothing was sent.');
  return person;
}

export async function configure(action, { home = homePath(), format, dws = runDws } = {}) {
  const config = settings(home);
  if (format && !FORMATS.includes(format)) throw new Error(`Choose a DingTalk format: ${FORMATS.join(' | ')}`);
  if (action === 'on') {
    const data = await dws(['profile', 'list']);
    const current = data.profiles?.filter((p) => p.isCurrent === true && p.isOrgCurrent === true);
    if (current?.length !== 1) throw new Error('Choose one default DingTalk account with dws before enabling delivery.');
    const person = await self(current[0].profile, dws);
    if (person.corpId !== current[0].corpId) throw new Error('DingTalk account and organization do not match. Nothing was enabled.');
    config.profile = current[0].profile;
    config.corpId = person.corpId;
    config.userId = person.userId;
    config.enabled = true;
  } else if (action === 'off') config.enabled = false;
  else if (action !== 'status') throw new Error('Use dingtalk.mjs config on | off | status [--format html|pdf|png|both]');
  if (format) config.format = format;
  if (action !== 'status' || format) save(configPath(home), config);
  return { status: config.enabled ? 'enabled' : 'disabled', format: config.format, target: 'self', accountBound: Boolean(config.profile) };
}

export function exportFiles(file, directory, format) {
  if (format === 'html') {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, basename(file));
    copyFileSync(file, target);
    return [target];
  }
  const args = ['export', file];
  if (format !== 'png') args.push('--pdf', join(directory, `${basename(file, extname(file))}.pdf`));
  if (format !== 'pdf') args.push('--png', directory);
  const output = execFileSync(process.execPath, [join(dirname(SCRIPT), 'am.mjs'), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
  });
  return [...output.matchAll(/^✓ (.+)$/gm)].map((match) => match[1]);
}

// Some installed DWS versions wrap the task in JSON text or a result array. Accept one unambiguous documented task ID.
export function taskId(data) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
      try { visit(JSON.parse(value)); } catch { /* ordinary text */ }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'openTaskId' && typeof child === 'string' && child) found.add(child);
        else visit(child);
      }
    }
  };
  visit(data);
  return found.size === 1 ? [...found][0] : undefined;
}

async function verify(item, profile, { dws, wait, userId, directory }) {
  if (!item.openTaskId) {
    // Recover an interrupted submission by reading this exact file back from self-chat, never by resending it.
    const expected = digest(readFileSync(join(directory, 'files', item.file)));
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = await dws(['chat', '+chat-messages', '--user', userId, '--profile', profile, '--limit', '10', '--no-reactions']);
      for (const message of data.messages || []) {
        for (const ref of message.resourceRefs || []) {
          if (ref.type !== 'fileId' || ref.name !== item.file || !ref.resourceId) continue;
          const local = `received-${randomUUID()}${extname(item.file)}`;
          await dws(['chat', '+messages-resource-download', '--type', 'fileId', '--resource-id', ref.resourceId,
            '--output', `./${local}`, '--profile', profile], { cwd: directory });
          const path = join(directory, local);
          const matches = digest(readFileSync(path)) === expected;
          rmSync(path);
          if (matches) {
            item.status = 'sent';
            item.verification = 'received-file-sha256';
            item.messageRef = { openMessageId: message.messageId, openConversationId: message.conversationId };
            return;
          }
        }
      }
      if (attempt < 3) await wait(1000);
    }
    return;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await dws(['chat', '+messages-query-send-status', '--open-task-id', item.openTaskId, '--profile', profile]);
    const status = data.result?.sendStatus;
    item.sendStatus = status || 'UNKNOWN';
    if (status === 'SUCCESS') {
      item.status = 'sent';
      item.messageRef = data.messageRef;
      return;
    }
    if (['FAILED', 'FAIL', 'FAILURE'].includes(status)) {
      item.status = 'failed';
      return;
    }
    if (attempt < 3) await wait(1000);
  }
}

// Opt-in is local and bound to the authenticated account, never to a recipient supplied by a page or its comments.
export async function deliver(file, {
  home = homePath(), format, dryRun = false, dws = runDws, exporter = exportFiles, wait = delay,
} = {}) {
  const config = settings(home);
  if (!config.enabled) return { status: 'disabled' };
  if (![config.profile, config.corpId, config.userId].every((value) => typeof value === 'string' && value.length)) {
    throw new Error('DingTalk account is not bound. Run dingtalk.mjs config on again.');
  }
  format ||= config.format;
  if (!FORMATS.includes(format)) throw new Error(`Choose a DingTalk format: ${FORMATS.join(' | ')}`);
  file = resolve(file);
  const source = readFileSync(file);
  const root = source.toString('utf8').match(/<html\b[^>]*>/)?.[0] || '';
  if (extname(file).toLowerCase() !== '.html' || !source.includes(Buffer.from('id="am-source"')) || /\sdata-video(?:\s|>)/.test(root)) {
    throw new Error('Pass a finished HTML report made by am render, not a video or an arbitrary file.');
  }
  const person = await self(config.profile, dws);
  if (person.corpId !== config.corpId || person.userId !== config.userId) throw new Error('DingTalk returned a different account. Nothing was sent.');
  const key = digest(Buffer.concat([Buffer.from(`${config.profile}\n${config.corpId}\n${config.userId}\n${format}\n`), source]));
  const directory = join(home, 'dingtalk', key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('This report has a delivery in progress or an interrupted lock. Inspect its local receipt before retrying.');
    throw e;
  }
  const receiptPath = join(directory, 'receipt.json');
  try {
    const receipt = existsSync(receiptPath) ? json(receiptPath) : { sourceSha256: digest(source), format, items: [] };
    if (receipt.items.length && receipt.items.every((item) => item.status === 'sent')) {
      return { status: 'already-sent', files: receipt.items.length, receipt: receiptPath };
    }
    if (!receipt.items.length) {
      const files = await exporter(file, join(directory, 'files'), format);
      if (!files.length) throw new Error('The export produced no files. Nothing was sent.');
      receipt.items = files.map((path) => {
        if (dirname(resolve(path)) !== join(directory, 'files') || !['.html', '.pdf', '.png'].includes(extname(path).toLowerCase())) {
          throw new Error('The export returned an unexpected file. Nothing was sent.');
        }
        return { file: basename(path), idempotencyKey: randomUUID(), status: 'ready' };
      });
      save(receiptPath, receipt);
    }
    if (dryRun) return { status: 'prepared', files: receipt.items.map((item) => join(directory, 'files', item.file)), receipt: receiptPath };
    for (const item of receipt.items) {
      if (item.status === 'sent') continue;
      if (item.status === 'ready') {
        // Save before starting a write. After interruption, query the recorded task; never submit again blindly.
        item.status = 'sending';
        save(receiptPath, receipt);
        const data = await dws([
          'chat', '+messages-send', '--as', 'user', '--profile', config.profile, '--user', person.userId,
          '--msg-type', 'file', '--file', `./${item.file}`, '--idempotency-key', item.idempotencyKey, '--yes',
        ], { cwd: join(directory, 'files') });
        item.openTaskId = taskId(data);
        save(receiptPath, receipt);
      }
      await verify(item, config.profile, { dws, wait, userId: person.userId, directory });
      save(receiptPath, receipt);
      if (item.status !== 'sent') throw new Error(`DingTalk delivery is ${item.sendStatus || item.status}; no automatic resend. Receipt: ${receiptPath}`);
    }
    receipt.verifiedAt = new Date().toISOString();
    save(receiptPath, receipt);
    return { status: 'sent', files: receipt.items.length, receipt: receiptPath };
  } finally {
    rmSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    const { values, positionals } = parseArgs({ options: { format: { type: 'string' }, 'dry-run': { type: 'boolean' } }, allowPositionals: true });
    let result;
    if (positionals[0] === 'config') result = await configure(positionals[1] || 'status', { format: values.format });
    else if (positionals[0] === 'send' && positionals[1]) result = await deliver(positionals[1], { format: values.format, dryRun: values['dry-run'] });
    else throw new Error('Usage: dingtalk.mjs config on|off|status [--format html|pdf|png|both] | send <page.html> [--format html|pdf|png|both] [--dry-run]');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', message: error.message }));
    process.exitCode = 1;
  }
}
