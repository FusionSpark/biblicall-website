# biblicall-rooms

Live group "calls" for biblicall.com. One Durable Object per room relays messages over WebSockets,
asks the Biblicall AI worker for answers (via the `AI` service binding), and decides whether a North Star fits.
Clients re-verify every North Star verse against kjv.json before showing it.

Deploy: Cloudflare Workers Builds, root directory `rooms-worker`, command `npx wrangler deploy`.
Rooms are deleted after 30 days without activity.
