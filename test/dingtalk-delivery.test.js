import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { configure, deliver, exportFiles, settings, taskId } from '../skills/answer-me-with-html/scripts/dingtalk.mjs';

const SELF = { success: true, result: [{ orgEmployeeModel: { corpId: 'example-corp', userId: 'self-user' } }] };
const PROFILES = { success: true, profiles: [{ profile: 'example-corp', corpId: 'example-corp', isCurrent: true, isOrgCurrent: true }] };

function fixture(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'am-dingtalk-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'dingtalk.json'), JSON.stringify({ enabled: true, profile: 'example-corp', corpId: 'example-corp', userId: 'self-user', format: 'pdf' }));
  const file = join(home, 'report.html');
  writeFileSync(file, '<html><head><style>html[data-video] { color: red; }</style></head><body><script id="am-source">Draft</script></body></html>');
  const calls = [];
  const dws = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'profile') return PROFILES;
    if (args[0] === 'contact') return SELF;
    if (args[1] === '+chat-messages') return { messages: [] };
    if (args[1] === '+messages-send') return { success: true, result: { openTaskId: 'task-for-self' } };
    if (args[1] === '+messages-query-send-status') return { success: true, result: { sendStatus: 'SUCCESS' }, messageRef: { openMessageId: 'sent-message' } };
    throw new Error('Unexpected command');
  };
  const exporter = async (_file, directory, format) => {
    calls.push({ export: format });
    mkdirSync(directory, { recursive: true });
    const names = format === 'pdf' ? ['report.pdf'] : format === 'png' ? ['report-1.png', 'report-2.png'] : ['report.pdf', 'report-1.png'];
    return names.map((name) => {
      const path = join(directory, name);
      writeFileSync(path, 'Exported report');
      return path;
    });
  };
  return { home, file, calls, options: { home, dws, exporter, wait: async () => {}, ...overrides } };
}

test('DingTalk: a copied skill is disabled until locally enabled, without auth or export side effects', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'am-dingtalk-off-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(settings(home).enabled, false);
  assert.equal(settings(home).format, 'html');
  assert.deepEqual(await deliver('missing.html', { home, dws: () => assert.fail('must not read auth') }), { status: 'disabled' });
});

test('DingTalk: wrapped task IDs remain queryable, and conflicting task IDs are not guessed', () => {
  assert.equal(taskId({ result: [{ content: [{ text: '{"openTaskId":"one-task"}' }] }] }), 'one-task');
  assert.equal(taskId({ result: [{ openTaskId: 'one' }, { openTaskId: 'two' }] }), undefined);
});

test('DingTalk: a submission without a task ID is verified by exact file readback, without a second send', async (t) => {
  const f = fixture(t);
  let sends = 0;
  const dws = async (args, options) => {
    if (args[1] === '+messages-send') { sends++; return { success: true }; }
    if (args[1] === '+chat-messages') return { messages: [{ messageId: 'received', conversationId: 'self-chat', resourceRefs: [{ type: 'fileId', name: 'report.pdf', resourceId: 'received-file' }] }] };
    if (args[1] === '+messages-resource-download') {
      writeFileSync(join(options.cwd, args[args.indexOf('--output') + 1]), 'Exported report');
      return { success: true };
    }
    return f.options.dws(args, options);
  };
  const result = await deliver(f.file, { ...f.options, dws });
  assert.equal(result.status, 'sent');
  const item = JSON.parse(readFileSync(result.receipt, 'utf8')).items[0];
  assert.equal(item.verification, 'received-file-sha256');
  assert.equal(item.messageRef.openMessageId, 'received');
  assert.equal((await deliver(f.file, { ...f.options, dws })).status, 'already-sent');
  assert.equal(sends, 1);
});

test('DingTalk: a same-name file with different bytes does not establish delivery', async (t) => {
  const f = fixture(t);
  const dws = async (args, options) => {
    if (args[1] === '+messages-send') return { success: true };
    if (args[1] === '+chat-messages') return { messages: [{ messageId: 'old', resourceRefs: [{ type: 'fileId', name: 'report.pdf', resourceId: 'old-file' }] }] };
    if (args[1] === '+messages-resource-download') {
      writeFileSync(join(options.cwd, args[args.indexOf('--output') + 1]), 'An older report');
      return { success: true };
    }
    return f.options.dws(args, options);
  };
  await assert.rejects(deliver(f.file, { ...f.options, dws }), /no automatic resend/);
});

test('DingTalk: HTML delivery preserves the complete source bytes, and an explicit PDF request does not change the default', async (t) => {
  const f = fixture(t);
  const config = join(f.home, 'dingtalk.json');
  writeFileSync(config, JSON.stringify({ enabled: true, profile: 'example-corp', corpId: 'example-corp', userId: 'self-user', format: 'html' }));
  const result = await deliver(f.file, { ...f.options, exporter: exportFiles });
  assert.equal(result.status, 'sent');
  const send = f.calls.find((call) => call.args?.[1] === '+messages-send');
  assert.equal(send.args[send.args.indexOf('--file') + 1], './report.html');
  assert.deepEqual(readFileSync(join(send.options.cwd, 'report.html')), readFileSync(f.file));
  assert.equal((await deliver(f.file, { ...f.options, format: 'pdf' })).status, 'sent');
  assert.equal(settings(f.home).format, 'html');
});

test('DingTalk: enabling binds the authenticated self, and disabling retains format without touching credentials', async (t) => {
  const f = fixture(t);
  await configure('on', { home: f.home, dws: f.options.dws, format: 'both' });
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'dingtalk.json'), 'utf8')), { enabled: true, format: 'both', profile: 'example-corp', corpId: 'example-corp', userId: 'self-user' });
  assert.equal((await configure('off', { home: f.home })).status, 'disabled');
  assert.equal(settings(f.home).format, 'both');
  assert.deepEqual(f.calls.map((call) => call.args[0]), ['profile', 'contact']);
});

test('DingTalk: ambiguous accounts and changed self identity stop before exporting or sending', async (t) => {
  const f = fixture(t);
  await assert.rejects(configure('on', { home: f.home, dws: async () => ({ profiles: [...PROFILES.profiles, ...PROFILES.profiles] }) }), /one default/);
  await assert.rejects(deliver(f.file, { ...f.options, dws: async () => ({ result: [{ orgEmployeeModel: { corpId: 'another-corp', userId: 'other-user' } }] }) }), /different account/);
  assert.equal(f.calls.length, 0);
});

test('DingTalk: sends only to verified self under one profile, then checks terminal status and deduplicates reruns', async (t) => {
  const f = fixture(t);
  const result = await deliver(f.file, f.options);
  assert.equal(result.status, 'sent');
  const send = f.calls.find((call) => call.args?.[1] === '+messages-send');
  assert.equal(send.args[send.args.indexOf('--user') + 1], 'self-user');
  assert.equal(send.args[send.args.indexOf('--file') + 1], './report.pdf');
  assert.equal(send.args.includes('--yes'), true);
  assert.equal(send.args.includes('--group'), false);
  for (const call of f.calls.filter((call) => call.args?.includes('--profile'))) {
    assert.equal(call.args[call.args.indexOf('--profile') + 1], 'example-corp');
  }
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
  assert.equal(receipt.items[0].sendStatus, 'SUCCESS');
  assert.equal(receipt.items[0].messageRef.openMessageId, 'sent-message');
  assert.equal((await deliver(f.file, f.options)).status, 'already-sent');
  assert.equal(f.calls.filter((call) => call.args?.[1] === '+messages-send').length, 1);
  assert.equal(f.calls.filter((call) => call.export).length, 1);
});

test('DingTalk: dry-run prepares both formats without sending, and the next run reuses those files', async (t) => {
  const f = fixture(t);
  const prepared = await deliver(f.file, { ...f.options, format: 'both', dryRun: true });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.files.map((path) => basename(path)), ['report.pdf', 'report-1.png']);
  assert.equal(f.calls.filter((call) => call.args?.[0] === 'chat').length, 0);
  assert.equal((await deliver(f.file, { ...f.options, format: 'both' })).status, 'sent');
  assert.equal(f.calls.filter((call) => call.export).length, 1);
});

test('DingTalk: unknown status is queried on a rerun, never treated as delivery or submitted twice', async (t) => {
  const f = fixture(t);
  let success = false;
  const dws = async (args, options) => args[1] === '+messages-query-send-status'
    ? { success: true, result: { sendStatus: success ? 'SUCCESS' : 'PROCESSING' } }
    : f.options.dws(args, options);
  await assert.rejects(deliver(f.file, { ...f.options, dws }), /PROCESSING/);
  success = true;
  assert.equal((await deliver(f.file, { ...f.options, dws })).status, 'sent');
  assert.equal(f.calls.filter((call) => call.args?.[1] === '+messages-send').length, 1);
});

test('DingTalk: an interrupted write with no task ID cannot silently resend on the next call', async (t) => {
  const f = fixture(t);
  const dws = async (args, options) => {
    if (args[1] === '+messages-send') { f.calls.push({ args }); throw new Error('Write connection lost'); }
    return f.options.dws(args, options);
  };
  await assert.rejects(deliver(f.file, { ...f.options, dws }), /connection lost/);
  await assert.rejects(deliver(f.file, { ...f.options, dws }), /no automatic resend/);
  assert.equal(f.calls.filter((call) => call.args?.[1] === '+messages-send').length, 1);
});

test('DingTalk: partial file delivery preserves successes and never starts later files after a failure', async (t) => {
  const f = fixture(t);
  let writes = 0;
  const dws = async (args, options) => {
    if (args[1] === '+messages-send') writes++;
    if (args[1] === '+messages-query-send-status' && writes === 2) return { result: { sendStatus: 'FAILED' } };
    return f.options.dws(args, options);
  };
  await assert.rejects(deliver(f.file, { ...f.options, dws, format: 'png' }), /FAILED/);
  await assert.rejects(deliver(f.file, { ...f.options, dws, format: 'png' }), /FAILED/);
  assert.equal(writes, 2);
});

test('DingTalk: video pages and exporter paths outside the prepared folder are refused before writing to IM', async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, '<html data-video><script id="am-source">Draft</script></html>');
  await assert.rejects(deliver(f.file, f.options), /not a video/);
  writeFileSync(f.file, '<html><script id="am-source">Draft</script></html>');
  await assert.rejects(deliver(f.file, { ...f.options, exporter: async () => ['/outside/private.pdf'] }), /unexpected file/);
  assert.equal(f.calls.filter((call) => call.args?.[0] === 'chat').length, 0);
});
