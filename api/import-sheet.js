const MAX_CSV_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

function normalizePublishedSpreadsheetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("スプレッドシートURLが指定されていません。");
  }

  if (rawUrl.length > 4096) {
    throw new Error("スプレッドシートURLが長すぎます。");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URLの形式が正しくありません。");
  }

  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new Error("docs.google.com のHTTPS URLだけを使用できます。");
  }

  if (url.username || url.password || url.port) {
    throw new Error("認証情報やポート番号を含むURLは使用できません。");
  }

  const match = url.pathname.match(
    /^\/spreadsheets\/d\/e\/([^/]+)\/(pub|pubhtml)\/?$/
  );

  if (!match) {
    if (/^\/spreadsheets\/d\/[^/]+\/(edit|view)/.test(url.pathname)) {
      throw new Error(
        "通常の編集URL・共有URLではなく、「ウェブに公開」で発行されたURLを使用してください。"
      );
    }
    throw new Error("Googleスプレッドシートの公開URLとして認識できません。");
  }

  url.pathname = `/spreadsheets/d/e/${match[1]}/pub`;
  url.searchParams.set("output", "csv");
  url.searchParams.delete("embedded");
  url.searchParams.delete("widget");
  url.hash = "";

  return url;
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "GETメソッドだけを使用できます。" });
    return;
  }

  const requestUrl = new URL(
    request.url || "/api/import-sheet",
    `https://${request.headers.host || "localhost"}`
  );

  let sourceUrl;
  try {
    sourceUrl = normalizePublishedSpreadsheetUrl(
      requestUrl.searchParams.get("url") || ""
    );
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "URLを確認してください。"
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "RouletteSheetImporter/1.0"
      }
    });

    if (!upstreamResponse.ok) {
      sendJson(response, 502, {
        error: `Googleスプレッドシートからデータを取得できませんでした（HTTP ${upstreamResponse.status}）。公開設定とURLを確認してください。`
      });
      return;
    }

    const contentLength = Number(
      upstreamResponse.headers.get("content-length") || "0"
    );
    if (contentLength > MAX_CSV_BYTES) {
      sendJson(response, 413, {
        error: "スプレッドシートのデータ量が大きすぎます。5MB以下にしてください。"
      });
      return;
    }

    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    if (buffer.length > MAX_CSV_BYTES) {
      sendJson(response, 413, {
        error: "スプレッドシートのデータ量が大きすぎます。5MB以下にしてください。"
      });
      return;
    }

    const csvText = buffer.toString("utf8");
    const trimmedStart = csvText.trimStart().toLowerCase();
    const contentType = (
      upstreamResponse.headers.get("content-type") || ""
    ).toLowerCase();

    if (
      !csvText.trim() ||
      contentType.includes("text/html") ||
      trimmedStart.startsWith("<!doctype html") ||
      trimmedStart.startsWith("<html")
    ) {
      sendJson(response, 502, {
        error: "CSVデータを取得できませんでした。対象シートを「ウェブに公開」し、発行された公開URLを使用してください。"
      });
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(csvText);
  } catch (error) {
    if (error && error.name === "AbortError") {
      sendJson(response, 504, {
        error: "Googleスプレッドシートの読み込みがタイムアウトしました。"
      });
      return;
    }

    sendJson(response, 502, {
      error: "Googleスプレッドシートへの接続に失敗しました。時間を置いて再度お試しください。"
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

module.exports.normalizePublishedSpreadsheetUrl = normalizePublishedSpreadsheetUrl;
