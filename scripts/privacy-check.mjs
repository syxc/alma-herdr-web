#!/usr/bin/env node
// Check working files by default; pre-commit uses the index snapshot with --staged.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staged = process.argv.includes('--staged');

function git(args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
  });
}

function candidates() {
  if (!staged) {
    return git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean).map(file => ({ file }));
  }
  return git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (match === null || match[3] !== '0') throw new Error('unmerged index');
    return { file: match[4], object: match[2] };
  });
}

const pathPatterns = [
  { name: 'a path of this machine', pattern: /\/(?:Users|home|Volumes)\/[^\s"'\x60]+/g },
  { name: 'a path of this machine', pattern: /\/(?:private\/var|var)\/folders\/[^\s"'\x60]+/g },
  { name: 'an application path', pattern: /\/Applications\/[^\s"'\x60]+/g },
  { name: 'a path of this machine', pattern: /(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'\x60]+/g },
  { name: 'a local file URL', pattern: /file:\/\/\/[^\s"'\x60]+/g }
];
const addressPatterns = [{
  name: 'an address of the local network',
  pattern: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g
}];
const forbiddenNames = /(?:relay\.json|\.env(?:\..*)?|\.pem|\.key|id_rsa|credentials)/i;
const forbiddenExtensions = /\.(?:png|jpe?g|gif|webp|heic|pdf|zip|tar|gz|keystore|mobileprovision|p12|pfx)$/i;

function looksLikeBase64Secret(value) {
  // A 32-byte code has 43 characters and two zero padding bits in its last sextet.
  return /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

function isPlaceholder(value) {
  // A valid code stays sensitive even when its characters happen to spell a fixture word.
  if (looksLikeBase64Secret(value) || /^[0-9a-f]{64}$/i.test(value)) return false;
  return value.length === 0 || /[<>\u2026]/.test(value) || /^[*x]{3,}$/i.test(value) ||
    /^(?:code|token|secret|test|mock|example|dummy|fake|placeholder|wrong)(?:[-_][a-z0-9]+)*$/i.test(value);
}

const secretWord = /(?:connect[\s_-]?code|routing[\s_-]?token|\btoken\b|\bcode\b|\bsecret\b|\bpsk\b|passphrase|password)/i;
const namedSecret = /\b(?:connect[\s_-]?code|routing[\s_-]?token|relay[\s_-]?key|api[\s_-]?key|access[\s_-]?token|code|token|psk|secret|password)["'\x60]?\s*[:=]\s*["'\x60]([A-Za-z0-9_+\-/=]{16,})["'\x60]/gi;
const almaLink = /alma:\/\/connect\?[^\s"'\x60]*/g;
const pairLink = /[#&]pair=([A-Za-z0-9_+\-/=]+)/g;
const base64Token = /[A-Za-z0-9_-]+/g;

function carriesPairing(value) {
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return payload !== null && typeof payload === 'object' &&
      (Object.hasOwn(payload, 'code') || Object.hasOwn(payload, 'token'));
  } catch {
    return false;
  }
}

function checkFile(file, text, report) {
  if (text.includes('\u0000')) return;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const finding = message => report(file, index + 1, message);
    for (const check of [...pathPatterns, ...addressPatterns]) {
      if (line.match(check.pattern) !== null) finding(check.name);
    }
    if (/BEGIN [A-Z ]*PRIVATE KEY/.test(line)) finding('a private key');

    const reported = new Set();
    for (const match of line.matchAll(namedSecret)) {
      if (!isPlaceholder(match[1])) {
        reported.add(match[1]);
        finding('a secret written next to its name');
      }
    }
    for (const match of line.matchAll(almaLink)) {
      const code = /[?&]k=([^&\s"']+)/.exec(match[0]);
      if (code !== null && code[1].length >= 16 && !isPlaceholder(code[1])) {
        reported.add(code[1]);
        finding('a connect code in a deep link');
      }
    }
    for (const match of line.matchAll(pairLink)) {
      if (carriesPairing(match[1]) && !reported.has(match[1])) {
        reported.add(match[1]);
        finding('a pairing payload that carries a code');
      }
    }
    for (const token of line.match(base64Token) ?? []) {
      if (reported.has(token)) continue;
      if (looksLikeBase64Secret(token)) {
        finding('a value shaped like a connect code');
      } else if (token.length === 64 && /^[0-9a-f]{64}$/i.test(token) && secretWord.test(line)) {
        finding('a connect code of this project');
      } else if (token.length > 43 && carriesPairing(token)) {
        finding('a pairing payload that carries a code');
      }
    }
  }
}

function main() {
  const entries = candidates();
  const findings = [];
  const report = (file, line, text) => findings.push({ file, line, text });
  for (const { file, object } of entries) {
    const absolute = join(root, file);
    if (!staged && (!existsSync(absolute) || !statSync(absolute).isFile())) continue;
    if (forbiddenNames.test(file)) {
      report(file, 0, 'a file that holds local state');
    } else if (forbiddenExtensions.test(file)) {
      report(file, 0, 'an image or an archive that can carry a pairing code');
    } else {
      // Read the captured blob ID, even if the working file was edited or removed after staging.
      const text = staged ? git(['cat-file', 'blob', object]) : readFileSync(absolute, 'utf8');
      checkFile(file, text, report);
    }
  }
  if (findings.length > 0) {
    console.error('privacy check found ' + findings.length + ' problem(s):');
    for (const finding of findings) {
      console.error('  ' + JSON.stringify(finding.file) +
        (finding.line > 0 ? ':' + finding.line : '') + '  ' + finding.text);
    }
    process.exitCode = 1;
    return;
  }
  console.log('privacy check passed: ' + entries.length + ' files (' +
    (staged ? 'index' : 'working tree') + ')');
  if (process.argv.includes('--install')) {
    const hook = resolve(root, git(['rev-parse', '--git-path', 'hooks/pre-commit']).trim());
    writeFileSync(hook, [
      '#!/bin/sh', '# Refuses a commit that would carry something private.',
      'node scripts/privacy-check.mjs --staged || exit 1', ''
    ].join('\n'), { mode: 0o755 });
    console.log('installed the pre-commit privacy check');
  }
}

try {
  main();
} catch {
  // Git and filesystem errors can contain private paths or blob contents.
  console.error('privacy check failed: could not read repository data');
  process.exitCode = 1;
}
