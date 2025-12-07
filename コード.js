// @ts-nocheck
/***** ================== Config ================== *****/
const QUEUE_FOLDER_NAME = 'inbox_submissions'; // 親フォルダ直下
// 音声保存先（親フォルダ直下）
const RECORDINGS_DIR = 'Recordings';

/***** ============== Web App Entry =============== *****/
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index');
}

/***** ================= Utilities =================*****/
function _s(v) { return v == null ? '' : String(v).trim(); }

// 親フォルダ（Webアプリの親）を取得
function getParentFolder_() {
  const scriptId = ScriptApp.getScriptId();
  const thisFile = DriveApp.getFileById(scriptId);
  const parents = thisFile.getParents();
  if (!parents.hasNext()) throw new Error('親フォルダが見つかりません。');
  return parents.next();
}

// 親フォルダ直下の Recordings を取得（無ければ作成）
function getOrCreateRecordingsFolder_() {
  const parent = getParentFolder_();
  const it = parent.getFoldersByName(RECORDINGS_DIR);
  return it.hasNext() ? it.next() : parent.createFolder(RECORDINGS_DIR);
}

/**
 * 音声を Recordings に保存し、viewURL を返す
 * @param {string} base64 - dataURL 形式 (e.g. "data:audio/webm;base64,....")
 * @param {string} mimeType - "audio/webm" 等
 * @param {Object} meta - { bookName, unitName, passageLabel, studentId4, score, variantLabel, timestamp12 }
 * @return {{fileId:string, viewUrl:string, filename:string}}
 */
function uploadAudioForSubmission(base64, mimeType, meta){
  const folder = getOrCreateRecordingsFolder_();

  // A/B 正規化
  function normalizeVariant_(v){
    const s = (v||'').toLowerCase();
    if (s.startsWith('a')) return 'A';
    if (s.startsWith('b')) return 'B';
    return '';
  }
  // 安全名
  function safeName_(s) {
    return (s==null?'':String(s))
      .replace(/[\r\n]/g, ' ')
      .replace(/[\\/:*?"<>|#%\u0000-\u001F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const y12 = (meta && meta.timestamp12) ? String(meta.timestamp12) : '';
  if (!y12 || !/^\d{12}$/.test(y12)) throw new Error('timestamp12 が不正です');

  const book = safeName_(meta.bookName);
  const unit = safeName_(meta.unitName);
  const pass = safeName_(meta.passageLabel);
  const sid4 = safeName_(meta.studentId4);
  const score = safeName_(meta.score);
  const varAB = normalizeVariant_(meta.variantLabel) || '_';
  const ext = (mimeType && String(mimeType).includes('webm')) ? 'webm' : 'ogg';

  const filename = `${book}_${unit}_${pass}_${sid4}_${score}_${varAB}_${y12}.${ext}`;
  const bytes = Utilities.base64Decode(String(base64).split(',')[1] || '');
  const blob = Utilities.newBlob(bytes, mimeType || 'audio/webm', filename);
  const file = folder.createFile(blob);
  const viewUrl = 'https://drive.google.com/file/d/'+file.getId()+'/view';
  return { fileId: file.getId(), viewUrl, filename };
}

// 親フォルダ直下の inbox_submissions を取得（無ければ作成）
function getQueueFolder_() {
  const parent = getParentFolder_();
  const it = parent.getFoldersByName(QUEUE_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(QUEUE_FOLDER_NAME);
}

// ファイル名を安全化（日本語は保持）
function safeName_(s) {
  return _s(s)
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\/:*?"<>|#%\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// 12桁日時（yyMMddHHmmss）
function now12Digits_() {
  const tz = Session.getScriptTimeZone();
  const y2 = Utilities.formatDate(new Date(), tz, 'yy');
  const md = Utilities.formatDate(new Date(), tz, 'MMdd');
  const hms = Utilities.formatDate(new Date(), tz, 'HHmmss');
  return y2 + md + hms;
}

// 英語バリエーション → A/B に正規化
function normalizeVariant_(v) {
  const s = _s(v).toLowerCase();
  if (s.startsWith('a')) return 'A'; // American
  if (s.startsWith('b')) return 'B'; // British
  return '';
}

// 必須チェック
function validatePayload_(p) {
  const missing = [];
  if (!_s(p.bookName)) missing.push('学年＋科目（bookName）');
  if (!_s(p.unitName)) missing.push('単元（unitName）');
  if (!_s(p.passageLabel)) missing.push('取り組む英文（passageLabel）');
  if (!_s(p.studentId4)) missing.push('生徒ID（studentId4）');
  if (!_s(p.studentName)) missing.push('氏名（studentName）');
  if (!_s(p.recognizedText)) missing.push('認識された英文（recognizedText）');
  if (_s(p.score) === '') missing.push('スコア（score）');
  if (!_s(p.variant)) missing.push('英語バリエーション（variant）');
  if (!_s(p.readWhileViewing) && _s(p.readWhileViewing) !== '') {
    missing.push('これを見ながら音読（readWhileViewing）');
  }
  // 追加：再生速度・シャドイングスコア（UIに表示された場合は必須扱い）
  if ('playbackRate' in p && _s(p.playbackRate)==='') missing.push('再生速度（playbackRate）');
  if ('shadowingScore' in p && _s(p.shadowingScore)==='') missing.push('シャドイングスコア（shadowingScore）');

  if (missing.length) throw new Error('必須項目が不足: ' + missing.join(', '));

  if (!/^\d{4}$/.test(_s(p.studentId4)))
    throw new Error('生徒ID（4桁）が不正です。');

  const n = Number(p.score);
  if (!isFinite(n)) throw new Error('スコア（score）は数値で指定してください。');

  if ('shadowingScore' in p) {
    const s = Number(p.shadowingScore);
    if (!isFinite(s)) throw new Error('シャドイングスコアは数値で指定してください。');
  }
}

// JSONレコード（キー順はご指定順）＋拡張（playbackRate, shadowingScore, audioUrl）
function buildJsonRecord_(p, tsISO) {
  const rec = {
    timestamp: tsISO,                 // 1) 提出日時
    book: _s(p.bookName),             // 2) 学年＋科目
    unit: _s(p.unitName),             // 3) 単元
    passage: _s(p.passageLabel),      // 4) 取り組む英文
    studentId: _s(p.studentId4),      // 5) 生徒ID（4桁）
    studentName: _s(p.studentName),   // 6) 氏名
    recognizedText: _s(p.recognizedText), // 7) 認識された英文
    score: Number(p.score),           // 8) スコア
    variant: normalizeVariant_(p.variant), // 9) A/B
    readWhileViewing: _s(p.readWhileViewing), // 10) これを見ながら音読
    requestId: _s(p.requestId || ''), // 任意メタ
    version: 'queue-json-v1'
  };
  if (_s(p.audioViewUrl)) rec.audioUrl = _s(p.audioViewUrl);
  if ('playbackRate' in p) rec.playbackRate = Number(p.playbackRate);
  if ('shadowingScore' in p) rec.shadowingScore = Number(p.shadowingScore);
  return rec;
}

// 命名規則：学年＋科目_単元_取り組む英文_生徒ID_スコア_英語バリエーション_12桁日時.json
function buildFilename_(p, y12) {
  const book = safeName_(_s(p.bookName));
  const unit = safeName_(_s(p.unitName));
  const pass = safeName_(_s(p.passageLabel));
  const sid4 = safeName_(_s(p.studentId4));
  const score = safeName_(_s(p.score));
  const varAB = normalizeVariant_(_s(p.variant)) || '_';
  return `${book}_${unit}_${pass}_${sid4}_${score}_${varAB}_${y12}.json`;
}

/***** ============== Public Server APIs ============== *****/
// JSON受付（キュー保存のみ）
function enqueueSubmission(payload){
  // 必須チェック
  validatePayload_(payload);

  // フロントで作った 12桁が来ていればそれを使う（音声と同一名にするため）
  let y12 = (payload && payload.timestamp12) ? String(payload.timestamp12) : '';
  if (!/^\d{12}$/.test(y12)) {
    y12 = now12Digits_(); // 万一欠落時はサーバで生成
  }

  const tz = Session.getScriptTimeZone();
  const iso = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");

  // JSONレコード作成（音声URL/再生速度/シャドイングスコアを含める）
  const record = buildJsonRecord_(payload, iso);

  // ファイル作成
  const queue = getQueueFolder_();
  const filename = buildFilename_(payload, y12);
  queue.createFile(
    Utilities.newBlob(JSON.stringify(record, null, 2), 'application/json', filename)
  );

  // ステータス返却（UI表示用）
  return {
    queued: true,
    filename: filename,
    queuedAt: iso,
    pendingCount: countPendingInQueue_()
  };
}

// 残っているJSONファイル数（UI用）
function getQueueStatus() {
  return { pending: countPendingInQueue_() };
}

/***** ================== Internals ================== *****/
function countPendingInQueue_() {
  const f = getQueueFolder_();
  const files = f.getFiles();
  let n = 0;
  while (files.hasNext()) { files.next(); n++; }
  return n;
}

/***** ====== Read-only PassageBooks APIs ====== *****/
// 設定：フォルダIDが分かるなら PASSAGE_BOOKS_FOLDER_ID に入れる。
// 不明なら親フォルダ直下の "PassageBooks" を探します。
const PASSAGE_BOOKS_FOLDER_ID = ''; // 例: '1_xf7MLL4rQ8X04r_f5MNq5vdlvoY7ue1'
const PASSAGE_BOOKS_FOLDER = 'PassageBooks';

function getPassageBooksFolder_(){
  if (_s(PASSAGE_BOOKS_FOLDER_ID)) return DriveApp.getFolderById(PASSAGE_BOOKS_FOLDER_ID);
  const parent = getParentFolder_();
  const it = parent.getFoldersByName(PASSAGE_BOOKS_FOLDER);
  if (!it.hasNext()) throw new Error('PassageBooks フォルダが見つかりません（PASSAGE_BOOKS_FOLDER_ID を設定するか、親直下に用意してください）。');
  return it.next();
}

function getPassageBooks(){
  const folder = getPassageBooksFolder_();
  const files = folder.getFiles();
  const out = [];
  while(files.hasNext()){
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS){
      out.push({ fileId: f.getId(), fileName: f.getName() });
    }
  }
  out.sort((a,b)=> a.fileName.localeCompare(b.fileName,'ja',{numeric:true}));
  return out;
}

function getSheetsInBook(fileId){
  const ss = SpreadsheetApp.openById(fileId);
  return ss.getSheets().map(s=> s.getName())
    .sort((a,b)=> a.localeCompare(b,'ja',{numeric:true}));
}

function _detectPassagesHeader(values){
  for (var r = 0; r < values.length; r++){
    var row = values[r].map(v=> _s(v).toLowerCase().replace(/\s+/g,''));
    var idx = {
      id: row.indexOf('id'),
      title: row.indexOf('title'),
      text_full: row.indexOf('text_full'),
      text_display: row.indexOf('text_display')
    };
    if (idx.id >= 0 && idx.text_full >= 0 && idx.text_display >= 0){
      return { headerRow: r, idx: idx };
    }
  }
  return { headerRow: 0, idx: { id:0, title:1, text_full:2, text_display:3 } };
}

function listPassageHeads(fileId, sheetName){
  const ss = SpreadsheetApp.openById(fileId);
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error(`Sheet "${sheetName}" not found in "${ss.getName()}"`);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return [];
  const headerScanRows = Math.min(50, lastRow);
  const headerBlock = sh.getRange(1, 1, headerScanRows, lastCol).getValues();
  const meta = _detectPassagesHeader(headerBlock);
  const dataStartRow = meta.headerRow + 2;
  const dataRows = lastRow - (meta.headerRow + 1);
  if (dataRows <= 0) return [];
  const MAX_ROWS = 50000;
  if (dataRows > MAX_ROWS) throw new Error(`Sheet too large: ${dataRows} rows (limit ${MAX_ROWS})`);
  const I = meta.idx;
  const colId = I.id + 1;
  const colTitle = I.title + 1;
  const colFull = I.text_full + 1;
  const colDisp = I.text_display + 1;

  const idVals = sh.getRange(dataStartRow, colId, dataRows, 1).getValues();
  const titleVals = sh.getRange(dataStartRow, colTitle, dataRows, 1).getValues();
  const fullVals = sh.getRange(dataStartRow, colFull, dataRows, 1).getValues();
  const dispVals = sh.getRange(dataStartRow, colDisp, dataRows, 1).getValues();

  const out = [];
  for (let i = 0; i < dataRows; i++){
    const id = _s(idVals[i][0]);
    const full = _s(fullVals[i][0]);
    const disp = _s(dispVals[i][0]);
    const title= _s(titleVals[i][0]);
    if (!id) continue;
    if (!full && !disp) continue;  // ← ここを緩和（どちらか一方でもOK）
    out.push({ id: id, title: title || id });
  }
  out.sort((a,b)=> a.id.localeCompare(b.id,'ja',{numeric:true}));
  return out;
}

/**
 * which: 'display' or 'full'
 * 返り値: { id, title, text, isAudioUrl?:boolean }
 *  - display指定時、text_display が URL かどうかを検出し isAudioUrl を付ける
 */
function getPassageText(fileId, sheetName, id, which){
  const ss = SpreadsheetApp.openById(fileId);
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error(`Sheet "${sheetName}" not found in "${ss.getName()}"`);
  const values = sh.getDataRange().getValues();
  if (values.length === 0) throw new Error('Sheet empty');
  const meta = _detectPassagesHeader(values);
  const I = meta.idx;
  const wantCol = (which === 'display') ? I.text_display : I.text_full; // display 指示で text_display
  if (wantCol == null || wantCol < 0) throw new Error('Required column not found');

  for (var r = meta.headerRow + 1; r < values.length; r++){
    var row = values[r];
    if (_s(row[I.id]) === _s(id)){
      const text = _s(row[wantCol]);
      const title = _s(row[I.title]) || _s(row[I.id]);
      if (which === 'display') {
        // URL 判定（Google Driveリンクや拡張子 .mp3/.wav/.webm なども）
        const isUrl = /^https?:\/\//i.test(text);
        return { id: _s(row[I.id]), title, text, isAudioUrl: !!isUrl };
      } else {
        return { id: _s(row[I.id]), title, text };
      }
    }
  }
  throw new Error('Specified ID not found: ' + id + ' (sheet="' + sheetName + '")');
}