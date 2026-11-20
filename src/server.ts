import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { LocalSellerAdapter } from './provider.ts';

const port = Number(process.env.PORT ?? 8787);
const db = openDb();
const adapter = new LocalSellerAdapter(db, {
  settle: (process.env.PATCHDUB_SETTLE as 'auto' | 'manual' | 'unresolvable') ?? 'auto',
});
const server = createApp({ db, adapter });

server.listen(port, () => {
  console.log(`patchdub api+console listening on http://localhost:${port}`);
  console.log(`rail: ${adapter.rail} (local emulator; live Kite rail not configured)`);
});
