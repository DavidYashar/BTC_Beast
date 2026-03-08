import 'dotenv/config';
import { initDb } from './src/memory/init-db.js';
import { embedText } from './src/memory/embeddings.js';
import { recordTweet, isTweetTooSimilar, recall, recordTokenSnapshot } from './src/memory/store.js';
import { pool } from './src/memory/db.js';

async function main() {
  // 1. Re-init DB (adds new columns/tables)
  await initDb();
  console.log('\n=== DB re-initialized with new tables ===');

  // 2. Test embedding dimensions
  const vec = await embedText('test embedding');
  console.log('\n=== Embedding Test ===');
  console.log('Dimensions:', vec.length);
  console.log('First 5 values:', vec.slice(0, 5).map(v => v.toFixed(6)));
  console.log('All numbers:', vec.every(v => typeof v === 'number' && !isNaN(v)));
  if (vec.length !== 1536) throw new Error(`Expected 1536 dimensions, got ${vec.length}`);

  // 3. Test recordTweet with embedding
  await recordTweet('test-embed-001', '$MAXI is pumping +47% on utxo.fun, bonding at 56%', 'test');
  console.log('\n=== Recorded test tweet with embedding ===');

  // 4. Test dedup: same-ish tweet should be similar (against the tweet we just inserted)
  const dedup1 = await isTweetTooSimilar('$MAXI pumping hard +50% on the utxo.fun DEX', 0.70, 48);
  console.log('\n=== Dedup: Similar tweet ===');
  console.log('Too similar:', dedup1.tooSimilar, '| Similarity:', (dedup1.similarity * 100).toFixed(1) + '%');
  console.log('Matched:', dedup1.matchedTweet?.slice(0, 60));

  // 5. Test dedup: different tweet should pass
  const dedup2 = await isTweetTooSimilar('Bitcoin hits new ATH as institutional demand surges worldwide', 0.70, 48);
  console.log('\n=== Dedup: Different tweet ===');
  console.log('Too similar:', dedup2.tooSimilar, '| Similarity:', (dedup2.similarity * 100).toFixed(1) + '%');

  // 6. Test token snapshot
  await recordTokenSnapshot({
    ticker: 'MAXI', name: 'Maxi Token', address: 'btkn1test',
    price_sats: 150, tvl_sats: 2000000, volume_24h_sats: 500000,
    price_change_24h_pct: 47.2, holders: 89, bonding_progress_pct: 56,
  });
  console.log('\n=== Recorded token snapshot ===');

  // 7. Test recall with token data
  const results = await recall('MAXI token bonding progress', 5);
  console.log('\n=== Recall results ===');
  for (const r of results) {
    console.log(`  [${r.table}] sim=${(r.similarity * 100).toFixed(1)}% | ${r.text.slice(0, 80)}`);
  }
  if (results.length === 0) throw new Error('Recall returned no results!');

  // 8. Clean up test data
  await pool.query("DELETE FROM tweets_posted WHERE tweet_id = 'test-embed-001'");
  await pool.query("DELETE FROM token_snapshots WHERE address = 'btkn1test'");
  console.log('\n=== Cleaned up test data ===');

  await pool.end();
  console.log('\n✓ ALL EMBEDDING TESTS PASSED');
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
