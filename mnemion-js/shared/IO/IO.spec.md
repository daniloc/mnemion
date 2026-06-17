# IO

Outbound and inbound adapters: derived publication renderers, web-URL resolution with caching, git pack assembly, and text extraction.

## works when
- publications.ts exists at this node
- web.ts exists at this node
- git.ts exists at this node
- extract.ts exists at this node

## why

IO holds the adapters that move data across the hive's boundary, kept as focused single-purpose modules so each owns one concern. Publications render live pattern projections at request time (never stored) per the "data is destiny" doctrine; `web.ts` caches adapter-fetched content as durable memory with a re-fetch-horizon TTL and refuses blocked hosts; `extract.ts` splits inline text extraction from async PDF extraction off the response path because only the DO has `waitUntil`, capping extracted text to stay under the entry size limit.
