/**
 * Firestore Native Title Case Formatter (Apps Script)
 * 
 * Single-file solution:
 *   1. Authenticates to Firestore REST API.
 *   2. Queries all investments for user 'Akk9Yh5dHzRb3IgjF9rOBJk1xex2'.
 *   3. Processes EVERY document where 'name' exists.
 *   4. Transforms the name to Title Case using native JS, respecting known acronyms.
 *   5. Patches 'name_title_case' back to Firestore.
 */

function formatAllNamesToTitleCaseNative() {
  const PROJECT_ID = "mypassive-inc";
  const USER_ID = "Akk9Yh5dHzRb3IgjF9rOBJk1xex2";

  const props = PropertiesService.getScriptProperties();
  const saJson = props.getProperty("FIREBASE_SERVICE_ACCOUNT_JSON");

  if (!saJson) throw new Error("Missing Script Property: FIREBASE_SERVICE_ACCOUNT_JSON");

  // 1. Authenticate with Firestore
  const accessToken = getFirestoreAccessToken_(saJson);

  // 2. Fetch All Investments
  const investments = fetchAllUserInvestments_({
    projectId: PROJECT_ID,
    userId: USER_ID,
    accessToken,
  });

  const updatedList = [];
  const failedList = [];

  // 3. Process EVERY record that has a source name
  investments.forEach((inv, index) => {
    if (inv.name) {
      try {
        // 4. Transform using dictionary-backed native JS heuristics
        const titleCasedName = toTitleCase_(inv.name);

        // 5. Update Firestore Document
        updateFirestoreTitleCase_({
          projectId: PROJECT_ID,
          docPath: inv.docPath,
          accessToken,
          titleCaseValue: titleCasedName,
        });

        updatedList.push(`${inv.name} -> ${titleCasedName}`);
        
        // Minor delay to respect Firestore REST API limits
        Utilities.sleep(100); 
      } catch (e) {
        failedList.push(`${inv.name}: ${e.message}`);
      }
    }
  });

  // Log Results
  Logger.log(`Successfully Updated: ${updatedList.length} records.`);
  if (updatedList.length > 0) Logger.log(updatedList.join("\n"));
  
  if (failedList.length > 0) {
    Logger.log(`Failed Updates: ${failedList.length} records.`);
    Logger.log(failedList.join("\n"));
  }
}

/**
 * Native JavaScript heuristic to convert strings to Title Case.
 * Bypasses formatting for recognized financial acronyms and ignores minor words.
 */
function toTitleCase_(str) {
  if (!str) return "";
  
  // List of words that should remain lowercase
  const minorWords = ['a', 'an', 'and', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'];
  
  // Custom dictionary of acronyms that should ALWAYS be capitalized
  const knownAcronyms = [
    'BGF', 'CIO', 'FTIF', 'ETF', 'ESG', 'MSCI', 
    'USA', 'UK', 'EM', 'REIT', 'S&P', 'USD', 'EUR', 'AB'
  ];
  
  return str.toLowerCase()
    // Split by spaces or hyphens, capturing the delimiter so we can join it back exactly
    .split(/([ \-])/) 
    .map((word, index) => {
      // Return delimiters unchanged
      if (word === ' ' || word === '-') return word;
      
      // If the word matches our acronym list, force it to ALL CAPS
      const upperWord = word.toUpperCase();
      if (knownAcronyms.includes(upperWord)) return upperWord;
      
      // Keep minor words lowercase unless they are the very first word
      if (index !== 0 && minorWords.includes(word)) return word;
      
      // Capitalize the first letter, leave the rest lowercase
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * Queries all investments from Firestore REST API.
 */
function fetchAllUserInvestments_({ projectId, userId, accessToken }) {
  const parent = `projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: "investments" }]
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
      name: getStringField_(fields, "name"),
      name_title_case: getStringField_(fields, "name_title_case"),
    });
  });

  return out;
}

/**
 * Writes the generated title case name back to the specific Firestore doc.
 */
function updateFirestoreTitleCase_({ projectId, docPath, accessToken, titleCaseValue }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}?updateMask.fieldPaths=name_title_case`;

  const body = {
    fields: {
      name_title_case: { stringValue: String(titleCaseValue || "") }
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

function getStringField_(fields, key) {
  const v = fields[key];
  if (!v) return "";
  if (typeof v.stringValue === "string") return v.stringValue;
  return "";
}

function base64UrlEncode_(input) {
  const bytes = (typeof input === "string") ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}