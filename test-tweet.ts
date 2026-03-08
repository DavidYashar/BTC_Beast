import 'dotenv/config';
import { postTweet } from './src/twitter/client.js';
try {
  const id = await postTweet('Hello World of Spark');
  console.log('Tweet posted! ID:', id);
} catch (e: any) {
  console.error('Failed:', e.message);
  if (e.stack) console.error(e.stack);
}
process.exit(0);
