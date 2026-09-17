export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("SKS Audio Assistant Worker is online.", {
        headers: {
          "content-type": "text/plain; charset=UTF-8",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram") {
      return Response.json({
        ok: true,
        message: "Telegram webhook endpoint is ready",
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
