import { fetchCollectionsWithRetry, initClient } from './client.js';
import {
  ensureCatalogCollection,
  isJunkCatalogKey,
  listCatalogCollections,
  loadCatalog,
  saveCatalog,
  syncCollectionThumbnails,
} from './store.js';

let inflight: Promise<boolean> | null = null;

/**
 * Один запрос GET /gifts/collections — имена для селектов в админке.
 * На хостинге без catalog.json после деплоя.
 */
export async function ensureCatalogCollectionsFromApi(): Promise<boolean> {
  if (listCatalogCollections(loadCatalog()).length > 0) return true;

  if (!inflight) {
    inflight = (async () => {
      try {
        await initClient();
        const remote = await fetchCollectionsWithRetry({
          retries: 2,
          timeoutMs: 25_000,
        });
        const catalog = loadCatalog();
        let added = 0;
        for (const col of remote) {
          if (isJunkCatalogKey(col.name)) continue;
          if (ensureCatalogCollection(catalog, col.name)) added++;
          syncCollectionThumbnails(catalog, col);
        }
        saveCatalog(catalog);
        const total = listCatalogCollections(catalog).length;
        console.log(
          `[catalog] bootstrap: ${total} коллекций с MRKT (новых имён: ${added})`,
        );
        return total > 0;
      } catch (err) {
        console.warn(
          '[catalog] bootstrap не удался (нужен MRKT_AUTH в env):',
          err instanceof Error ? err.message : err,
        );
        return false;
      } finally {
        inflight = null;
      }
    })();
  }

  return inflight;
}
