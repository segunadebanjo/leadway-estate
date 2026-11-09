import { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Modal, Table, downloadCsv } from './ui.jsx';

/** Saves rows as a CSV file Excel opens (cells that look like formulas are quoted). */
export function saveCsv(filename, columns, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [columns.map((c) => cell(c.label)), ...rows.map((r) => columns.map((c) => cell(c.map ? c.map(r) : r[c.key])))].map((r) => r.join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Upload a spreadsheet in two steps: "Check file" shows what would be added and
 * what is wrong (nothing is saved), then "Add" saves the good rows.
 *
 * noun: ['member', 'members']; columns: preview table columns for ready rows;
 * options: extra form fields { name: value } sent with both steps, with
 * renderOptions(options, setOptions) to draw them; renderDone(result) draws the result.
 */
export function ImportDialog({ title, noun, templateUrl, templateName, uploadUrl, intro, columns, options: initialOptions = {}, renderOptions, summary, renderDone, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [options, setOptions] = useState(initialOptions);
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const send = async (dryRun) => {
    const fd = new FormData();
    fd.append('dryRun', String(dryRun));
    for (const [k, v] of Object.entries(options)) fd.append(k, String(v));
    fd.append('file', file);
    return api.upload(uploadUrl, fd);
  };
  const check = async (e) => {
    e.preventDefault();
    if (!file) return setError(new Error('Choose a file first'));
    setBusy(true); setError(null); setPreview(null);
    try { setPreview(await send(true)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await send(false);
      setDone(r);
      onImported?.(r);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const many = (n) => `${n} ${n === 1 ? noun[0] : noun[1]}`;

  if (done) {
    return (
      <Modal title={title} onClose={onClose} wide>
        <div className="alert alert-good"><strong>{many(done.created.length)} added.</strong>{done.skipped.length ? ` ${done.skipped.length} skipped.` : ''}{done.errors.length ? ` ${done.errors.length} row(s) with problems were not added.` : ''}</div>
        {renderDone?.(done)}
        <Problems result={done} />
        <div className="actions" style={{ marginTop: 14 }}><button className="btn" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      {intro && <p className="muted" style={{ marginTop: 0 }}>{intro}</p>}
      <ol className="steps">
        <li>
          <button type="button" className="link-button" onClick={() => downloadCsv(templateUrl, templateName).catch(setError)}>Download the Excel template</button>{' '}
          and fill it in, one row each. Your own spreadsheet works too if its first row has the same column names.
        </li>
        <li>Save it as Excel (.xlsx) or CSV, choose it below and press <strong>Check file</strong>. Nothing is saved yet.</li>
        <li>Look at what will be added, then press <strong>Add</strong>.</li>
      </ol>
      <form onSubmit={check}>
        <ErrorNote error={error} />
        <div className="upload-row">
          <input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files[0] || null); setPreview(null); }} />
          <button className="btn btn-ghost" disabled={busy || !file}>{busy && !preview ? 'Checking…' : 'Check file'}</button>
        </div>
        {renderOptions?.(options, (o) => setOptions({ ...options, ...o }))}
      </form>

      {preview && (
        <>
          <div className={`alert ${preview.ready.length ? 'alert-info' : 'alert-warn'}`}>
            <strong>{preview.total} row(s) read.</strong> {many(preview.ready.length)} ready to add
            {summary ? summary(preview) : ''}
            {preview.skipped.length ? `, ${preview.skipped.length} already in the app (skipped)` : ''}
            {preview.errors.length ? `, ${preview.errors.length} with problems (fix them in the file and check again, or add the others now)` : ''}.
            {preview.ignoredColumns?.length > 0 && <div className="muted" style={{ fontSize: '.85rem' }}>Columns not used: {preview.ignoredColumns.join(', ')}</div>}
          </div>
          <Problems result={preview} />
          {preview.ready.length > 0 && (
            <>
              <h3 className="section-title">Will be added</h3>
              <div className="preview-scroll"><Table rows={preview.ready} rowKey="row" columns={[{ key: 'row', label: 'Row' }, ...columns]} /></div>
              <div className="actions" style={{ marginTop: 14 }}>
                <button className="btn" onClick={save} disabled={busy}>{busy ? 'Adding…' : `Add ${many(preview.ready.length)}`}</button>
                <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Problems({ result }) {
  return (
    <>
      {result.errors.length > 0 && (
        <>
          <h3 className="section-title text-bad">Problems (these rows are not added)</h3>
          <div className="preview-scroll"><Table rows={result.errors} rowKey="row" columns={[{ key: 'row', label: 'Row' }, { key: 'message', label: 'What to fix' }]} /></div>
        </>
      )}
      {result.skipped.length > 0 && (
        <details style={{ margin: '10px 0' }}>
          <summary>{result.skipped.length} skipped because already in the app</summary>
          <Table rows={result.skipped} rowKey="row" columns={[{ key: 'row', label: 'Row' }, { key: 'name', label: 'Name' }, { key: 'message', label: 'Why' }]} />
        </details>
      )}
    </>
  );
}
