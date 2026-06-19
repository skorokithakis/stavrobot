/**
 * GCF vs TOON vs JSON benchmark + TOON corruption proof on stavrobot data.
 * GCF = Graph Compact Format (https://gcformat.com)
 *
 * Uses realistic data shapes from stavrobot's actual code:
 * - Agent records (flat objects from database)
 * - Interlocutor records (flat objects)
 * - Memory records (flat objects with text content)
 * - Search results (table rows)
 * - SQL query results (mixed shapes)
 * - Plugin outputs (nested objects)
 *
 * Usage: node benchmarks/benchmark.mjs
 */

import { encode as toonEncode, decode as toonDecode } from '@toon-format/toon';
import { encodeGeneric, decodeGeneric } from '@blackwell-systems/gcf';

function tokenEstimate(text) {
  return Math.max(1, Math.floor(text.length / 4));
}

// --- Realistic stavrobot data generators ---

function generateAgents(n) {
  const tools = ['search', 'sql', 'web_browse', 'send_message', 'manage_cron', 'upload_file'];
  const plugins = ['weather', 'calendar', 'email', 'home-assistant', 'spotify'];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `agent-${i + 1}`,
    systemPrompt: `You are agent ${i + 1}. Help the user with tasks. Error code: ERR[${400 + i}]: ${i % 2 === 0 ? 'Not Found' : 'Forbidden'}.`,
    allowedTools: tools.slice(0, 2 + (i % 5)),
    allowedPlugins: plugins.slice(0, 1 + (i % 4)),
    createdAt: new Date(2026, 0, 1 + i).toISOString(),
  }));
}

function generateInterlocutors(n) {
  return Array.from({ length: n }, (_, i) => ({
    interlocutorId: i + 1,
    identityId: 100 + i,
    agentId: 1 + (i % 5),
    isOwner: i === 0,
    displayName: `User ${i + 1}`,
    channel: i % 3 === 0 ? 'signal' : i % 3 === 1 ? 'telegram' : 'web',
    lastSeen: new Date(2026, 5, 18, 10 + (i % 12), i % 60).toISOString(),
  }));
}

function generateMemories(n) {
  const contents = [
    'User prefers dark mode. Config path: [settings]: display.theme',
    'API key stored at /home/user/.config/stavrobot/keys.json',
    'Error encountered: ERR[503]: Service Unavailable. Retry after 30s.',
    'Meeting notes from [2026-06-15]: discussed project timeline',
    'Reminder: check logs at http://monitoring.local:9090/alerts',
    'User timezone is Europe/Athens (UTC+3)',
    '[WARNING]: disk space below 10% on /dev/sda1',
    'Preferred language: Greek (el). Fallback: English (en).',
    'Home automation: [light.living_room]: brightness=80, color_temp=3000K',
    'Signal bridge config: [bridge]: host=localhost, port=8443',
  ];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    content: contents[i % contents.length],
    createdAt: new Date(2026, 0, 1 + i).toISOString(),
    updatedAt: new Date(2026, 5, 18).toISOString(),
  }));
}

function generateSearchResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    tableName: ['messages', 'memories', 'uploads'][i % 3],
    matchCount: 1 + (i % 5),
    rows: Array.from({ length: 1 + (i % 3) }, (_, j) => ({
      id: i * 10 + j,
      content: `Result ${j}: path [${i}]: /var/log/app-${j}.log`,
      score: 0.85 + Math.random() * 0.15,
      createdAt: new Date(2026, 5, 18 - j).toISOString(),
    })),
  }));
}

function generateSqlResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    status: i % 4 === 0 ? 'ERR[500]: Internal Server Error' : 'ok',
    query: `SELECT * FROM table_${i} WHERE id > ${i * 10}`,
    rowCount: 10 + i * 5,
    duration_ms: 5 + Math.random() * 50,
  }));
}

// =====================================================================
// PART 1: TOKEN BENCHMARK
// =====================================================================

console.log('='.repeat(80));
console.log('PART 1: Token Benchmark — GCF vs TOON vs JSON on Stavrobot Data');
console.log('='.repeat(80));
console.log();

const datasets = [
  { name: 'Agents', gen: generateAgents },
  { name: 'Interlocutors', gen: generateInterlocutors },
  { name: 'Memories', gen: generateMemories },
  { name: 'Search Results', gen: generateSearchResults },
  { name: 'SQL Results', gen: generateSqlResults },
];

const SIZE = 200;

console.log(
  `${'Dataset'.padEnd(20)}  ${'JSON'.padStart(8)}  ${'TOON'.padStart(8)}  ${'GCF'.padStart(8)}  ${'TOON%'.padStart(7)}  ${'GCF%'.padStart(7)}  ${'GCF vs TOON'.padStart(12)}`
);
console.log('-'.repeat(80));

let totalJson = 0, totalToon = 0, totalGcf = 0;

for (const { name, gen } of datasets) {
  const data = gen(SIZE);
  const jsonStr = JSON.stringify(data);
  const toonStr = toonEncode(data);
  const gcfStr = encodeGeneric(data);

  const jsonTok = tokenEstimate(jsonStr);
  const toonTok = tokenEstimate(toonStr);
  const gcfTok = tokenEstimate(gcfStr);

  totalJson += jsonTok;
  totalToon += toonTok;
  totalGcf += gcfTok;

  const toonPct = ((1 - toonTok / jsonTok) * 100).toFixed(1);
  const gcfPct = ((1 - gcfTok / jsonTok) * 100).toFixed(1);
  const gcfVsToon = ((1 - gcfTok / toonTok) * 100).toFixed(1);

  console.log(
    `${name.padEnd(20)}  ${String(jsonTok).padStart(8)}  ${String(toonTok).padStart(8)}  ${String(gcfTok).padStart(8)}  ${(toonPct + '%').padStart(7)}  ${(gcfPct + '%').padStart(7)}  ${((gcfVsToon > 0 ? '+' : '') + gcfVsToon + '%').padStart(12)}`
  );
}

console.log('-'.repeat(80));
const toonTotalPct = ((1 - totalToon / totalJson) * 100).toFixed(1);
const gcfTotalPct = ((1 - totalGcf / totalJson) * 100).toFixed(1);
const gcfVsToonTotal = ((1 - totalGcf / totalToon) * 100).toFixed(1);
console.log(
  `${'TOTAL'.padEnd(20)}  ${String(totalJson).padStart(8)}  ${String(totalToon).padStart(8)}  ${String(totalGcf).padStart(8)}  ${(toonTotalPct + '%').padStart(7)}  ${(gcfTotalPct + '%').padStart(7)}  ${((gcfVsToonTotal > 0 ? '+' : '') + gcfVsToonTotal + '%').padStart(12)}`
);

// =====================================================================
// PART 2: TOON CORRUPTION PROOF
// =====================================================================

console.log();
console.log('='.repeat(80));
console.log('PART 2: TOON Corruption Proof — Round-Trip on Individual Records');
console.log('='.repeat(80));
console.log();

// Test individual records (flat objects, not arrays)
const testRecords = [
  ...generateAgents(10),
  ...generateMemories(10),
  ...generateSqlResults(10),
];

let toonCorruptions = 0;
let toonErrors = 0;
let gcfCorruptions = 0;
let gcfErrors = 0;

for (const record of testRecords) {
  // TOON round-trip
  try {
    const encoded = toonEncode(record);
    const decoded = toonDecode(encoded);
    if (JSON.stringify(decoded) !== JSON.stringify(record)) {
      toonCorruptions++;
      if (toonCorruptions <= 3) {
        console.log(`TOON SILENT CORRUPTION:`);
        console.log(`  Original: ${JSON.stringify(record).slice(0, 120)}...`);
        console.log(`  Decoded:  ${JSON.stringify(decoded).slice(0, 120)}...`);
        console.log();
      }
    }
  } catch (e) {
    toonErrors++;
    if (toonErrors <= 5) {
      console.log(`TOON DECODE ERROR: ${e.message}`);
      console.log(`  Record: ${JSON.stringify(record).slice(0, 120)}...`);
      console.log();
    }
  }

  // GCF round-trip
  try {
    const encoded = encodeGeneric(record);
    const decoded = decodeGeneric(encoded);
    if (JSON.stringify(decoded) !== JSON.stringify(record)) {
      gcfCorruptions++;
    }
  } catch (e) {
    gcfErrors++;
  }
}

console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log();
console.log(`Records tested: ${testRecords.length}`);
console.log(`TOON corruptions: ${toonCorruptions} | TOON errors: ${toonErrors} | Total failures: ${toonCorruptions + toonErrors}/${testRecords.length}`);
console.log(`GCF corruptions:  ${gcfCorruptions} | GCF errors:  ${gcfErrors} | Total failures: ${gcfCorruptions + gcfErrors}/${testRecords.length}`);
