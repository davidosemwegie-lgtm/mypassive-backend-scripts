/**
 * Firestore Portfolio Analyst (Apps Script)
 * 
 * Single-file solution:
 *   1. Authenticates to Firestore REST API using Service Account JSON.
 *   2. Queries active investments for user 'Akk9Yh5dHzRb3IgjF9rOBJk1xex2'.
 *   3. Analyzes each active investment using Gemini (gemini-3.5-flash) for resilience and geographic exposure.
 *   4. Patches 'resilience_short', 'resilience_long', and 'geo_exposure' back to Firestore.
 *   5. Includes a 3-attempt Retry Loop for API/JSON truncation glitches.
 *   6. Sends a summary email report upon completion.
 *
 * Required Script Properties:
 *   - FIREBASE_SERVICE_ACCOUNT_JSON  (Full service account JSON string)
 *   - GEMINI_API_KEY                 (Gemini API key)
 */

function analyzePortfolioWithGemini() {
  const PROJECT_ID = "mypassive-inc";
  const USER_ID = "Akk9Yh5dHzRb3IgjF9rOBJk1xex2";

  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty("GEMINI_API_KEY");
  const saJson = props.getProperty("FIREBASE_SERVICE_ACCOUNT_JSON");

  if (!geminiKey) throw new Error("Missing Script Property: GEMINI_API_KEY");
  if (!saJson) throw new Error("Missing Script Property: FIREBASE_SERVICE_ACCOUNT_JSON");

  // 1. Authenticate with Firestore
  const accessToken = getFirestoreAccessToken_(saJson);

  // 2. Fetch Active Investments
  const activeInvestments = fetchActiveUserInvestments_({
    projectId: PROJECT_ID,
    userId: USER_ID,
    accessToken,
  });

  const runDateStamp = `[${getFormattedDate_()}]`;
  const successfulList = [];
  const failedList = [];

  // 3. Process Each Investment with a Retry Loop
  activeInvestments.forEach((inv, index) => {
    const isin = inv.symbol || "";
    const fundName = inv.name || "";
    const emailName = inv.name_title_case || fundName || "Unknown Fund";

    if (!isin || !fundName) {
      failedList.push(`${emailName} (${inv.docPath}): Missing Symbol or Name`);
      return;
    }

    let success = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!success && attempts < maxAttempts) {
      attempts++;
      try {
        const summaries = generateResilienceWithGemini_({
          geminiKey,
          isin,
          fundName,
        });

        const resilienceShortWithDate = `${summaries.resilience_short} ${runDateStamp}`.trim();
        const resilienceLongWithDate = `${summaries.resilience_long} ${runDateStamp}`.trim();
        const geoExposureWithDate = `${summaries.geo_exposure} ${runDateStamp}`.trim();

        // 4. Update Firestore Document
        updateInvestmentResilienceFields_({
          projectId: PROJECT_ID,
          docPath: inv.docPath,
          accessToken,
          resilienceShort: resilienceShortWithDate,
          resilienceLong: resilienceLongWithDate,
          geoExposure: geoExposureWithDate,
        });

        successfulList.push(emailName);
        success = true; // Break the retry loop
      } catch (e) {
        if (attempts < maxAttempts) {
          Utilities.sleep(3000);
        } else {
          failedList.push(`${emailName}: ${e.message}`);
        }
      }
    }

    // Rate-limiting delay between Gemini calls for the next fund
    if (index < activeInvestments.length - 1) {
      Utilities.sleep(1000);
    }
  });

  // 5. Send Summary Email Report
  sendEmailReport_({
    successes: successfulList,
    failures: failedList,
  });
}

/**
 * Sends execution summary email to script runner or fallback address.
 */
function sendEmailReport_({ successes, failures }) {
  const recipient = Session.getActiveUser().getEmail() || "david.osemwegie@gmail.com";
  const overallStatus = failures.length === 0 ? "SUCCESS" : (successes.length > 0 ? "PARTIAL SUCCESS / COMPLETED WITH ERRORS" : "FAILED");
  const subject = `MyPassive Inc: Market Analysis Report (${successes.length} Updated) - ${overallStatus}`;

  let body = `Execution Status: ${overallStatus}\n\n`;
  body += "The automated portfolio analysis is complete.\n\n";

  body += "SUCCESSFUL:\n";
  if (successes.length === 0) {
    body += "None\n";
  } else {
    successes.forEach((s, index) => body += `${index + 1}. ${s}\n`);
  }

  body += "\nFAILED/SKIPPED:\n";
  if (failures.length === 0) {
    body += "None\n";
  } else {
    failures.forEach((f, index) => body += `${index + 1}. ${f}\n`);
  }

  MailApp.sendEmail(recipient, subject, body);
}

/**
 * Generates analysis with Gemini API using the active gemini-3.5-flash endpoint.
 */
function generateResilienceWithGemini_({ geminiKey, isin, fundName }) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`;

  const currentDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const prompt = `You are a financial analyst generating data-rich resilience, outlook summaries, and geographic exposure breakdowns for a mutual fund or ETF.
Analysis Date: ${currentDate}
Fund Name: ${fundName}
ISIN/Identifier: ${isin}

CRITICAL DATA & OUTLOOK REQUIREMENTS:
1. YIELD & CAGR: Include current yield (%) and compound annual growth rate (CAGR %). Provide CAGR for up to 10 years if available. If 10-year data is unavailable, state the available multi-year CAGR and explicitly state the exact period (e.g., "3-yr CAGR: 5.2%").
2. DIVIDEND RESILIENCE: State specific facts regarding dividend reliability (e.g., consecutive payment history, cuts, or payout stability).
3. DOWNTURN PERFORMANCE: Provide factual performance figures during major market downturns (2008 Financial Crisis and 2020 COVID-19 crash, if existed).
4. SHORT TO MEDIUM-TERM OUTLOOK: Evaluate the fund's short-to-medium-term outlook (6 to 24 months) considering prevailing macroeconomic factors as of ${currentDate} (e.g., current rate environment, market valuation levels, sector tailwinds/headwinds, inflation trends).
5. GEOGRAPHIC EXPOSURE: Using ISIN ${isin}, provide the percentage exposure breakdown of the fund across these exact regions/countries: USA, China, India, Europe, Rest of Asia, Canada, South America, and Other markets.

OUTPUT FORMAT INSTRUCTIONS:
- NAMING: Always refer to the fund by its name ("${fundName}"), but strictly format the name in standard Title Case (e.g., "Franklin Income Fund", do not use ALL CAPS). STRICT RULE: Do not include the ISIN in the resilience_short or resilience_long generated output.
- resilience_short: Maximum 280 characters. Extremely dense, plain English, no markdown, no emojis. Synthesize Yield, CAGR, downturn resilience, and a concise 1-sentence current market outlook.
- resilience_long: Provide a highly detailed, data-rich analysis that is at least 4 distinct paragraphs long. Structure the analysis to dedicate specific paragraphs to: (1) Yield and historical CAGR performance, (2) Dividend reliability and payout history, (3) Downturn stress-test performance (2008/2020 crashes), and (4) A forward-looking macroeconomic outlook. Focus strictly on factual investment metrics, actionable insights, and prevailing economic headwinds/tailwinds as of ${currentDate}. Strictly avoid repetitive filler, generic AI disclaimers, or flowery language. Plain English, no markdown. Use standard newline characters to separate paragraphs within the JSON string.
- geo_exposure: Plain English breakdown of percentage exposure for ISIN ${isin} across: USA, China, India, Europe, Rest of Asia, Canada, South America, and Other markets (e.g., USA: 50%, Europe: 20%, China: 10%, India: 5%, Rest of Asia: 5%, Canada: 5%, South America: 3%, Other: 2%). Plain English, no markdown.
- CONSERVATIVE FALLBACK: If historical data or specific metrics are missing due to recent fund inception, explicitly declare what data is unavailable. Do not invent metrics.`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { 
      temperature: 0.2, 
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          resilience_short: { type: "STRING" },
          resilience_long: { type: "STRING" },
          geo_exposure: { type: "STRING" }
        },
        required: ["resilience_short", "resilience_long", "geo_exposure"]
      }
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`API Error (HTTP ${code}): ${text}`);

  const data = JSON.parse(text);
  const raw = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join("") || "";
  const json = safeJsonParse_(raw);

  if (!json || typeof json !== "object") {
    throw new Error(`Gemini returned invalid response format: ${raw}`);
  }

  return {
    resilience_short: String(json.resilience_short || "").trim(),
    resilience_long: String(json.resilience_long || "").trim(),
    geo_exposure: String(json.geo_exposure || "").trim(),
  };
}

/**
 * Queries active investments from Firestore REST API.
 */
function fetchActiveUserInvestments_({ projectId, userId, accessToken }) {
  const parent = `projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: "investments" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "is_active" },
          op: "EQUAL",
          value: { booleanValue: true },
        },
      },
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`Firestore runQuery failed (HTTP ${code}): ${text}`);

  const rows = JSON.parse(text);
  const out = [];

  rows.forEach(r => {
    if (!r || !r.document) return;
    const doc = r.document;
    const docPath = doc.name.replace(`projects/${projectId}/databases/(default)/documents/`, "");
    const fields = doc.fields || {};

    out.push({
      docPath,
      symbol: getStringField_(fields, "symbol"),
      name: getStringField_(fields, "name"),
      name_title_case: getStringField_(fields, "name_title_case"),
      is_active: getBoolField_(fields, "is_active"),
    });
  });

  return out;
}

/**
 * Writes resilience_short, resilience_long, and geo_exposure back to Firestore doc.
 */
function updateInvestmentResilienceFields_({ projectId, docPath, accessToken, resilienceShort, resilienceLong, geoExposure }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}?updateMask.fieldPaths=resilience_short&updateMask.fieldPaths=resilience_long&updateMask.fieldPaths=geo_exposure`;

  const body = {
    fields: {
      resilience_short: { stringValue: String(resilienceShort || "") },
      resilience_long: { stringValue: String(resilienceLong || "") },
      geo_exposure: { stringValue: String(geoExposure || "") },
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`Firestore patch failed (HTTP ${code}): ${text}`);
}

/**
 * Creates OAuth2 access token for Firestore REST API using Service Account JSON.
 */
function getFirestoreAccessToken_(serviceAccountJsonString) {
  const sa = JSON.parse(serviceAccountJsonString);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encHeader = base64UrlEncode_(JSON.stringify(header));
  const encClaim = base64UrlEncode_(JSON.stringify(claimSet));
  const signingInput = `${encHeader}.${encClaim}`;

  const signatureBytes = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  const encSignature = base64UrlEncode_(signatureBytes);
  const jwt = `${signingInput}.${encSignature}`;

  const tokenRes = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  const code = tokenRes.getResponseCode();
  const text = tokenRes.getContentText();
  if (code < 200 || code >= 300) throw new Error(`OAuth Token exchange failed (HTTP ${code}): ${text}`);

  const tokenData = JSON.parse(text);
  return tokenData.access_token;
}

/* ----------------- Helper Functions ----------------- */

function getFormattedDate_() {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();

  return `${day}-${month}-${year}`;
}

function getStringField_(fields, key) {
  const v = fields[key];
  if (!v) return "";
  if (typeof v.stringValue === "string") return v.stringValue;
  return "";
}

function getBoolField_(fields, key) {
  const v = fields[key];
  if (!v) return false;
  if (typeof v.booleanValue === "boolean") return v.booleanValue;
  return false;
}

function base64UrlEncode_(input) {
  const bytes = (typeof input === "string") ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function safeJsonParse_(text) {
  try { return JSON.parse(text); } catch (e) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}