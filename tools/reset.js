// Wipes the local development KV store so the panel starts at first-run setup
// again. Only ever touches DENO_KV_PATH / the default data/ file — never Deno
// Deploy's managed database, which has no file to delete.
//
//   deno task reset
const DEFAULT_PATH = 'data/blueknight_kv.sqlite3';
const path = Deno.env.get('DENO_KV_PATH') || DEFAULT_PATH;

// SQLite keeps a write-ahead log and shared-memory file beside the database.
// Removing only the main file leaves those behind, and the next open can still
// see the old rows.
const sidecars = [`${path}-wal`, `${path}-shm`];

let removed = 0;
for (const target of [path, ...sidecars]) {
  try {
    await Deno.remove(target);
    removed++;
    console.log(`removed ${target}`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.error(`could not remove ${target}: ${err.message}`);
      Deno.exit(1);
    }
  }
}

console.log(removed ? '\nThe panel will ask for a new password.' : '\nNothing to remove — already clean.');
