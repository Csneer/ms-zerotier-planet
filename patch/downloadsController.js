'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const distPath = '/app/dist';
const allowedName = name => name === 'planet' || /^[0-9a-f]{16}\.moon$/.test(name);

function navigation() {
  return {active: 'downloads'};
}

async function fileInfo(name) {
  const fullPath = path.join(distPath, name);
  const handle = await fs.promises.open(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    const content = await handle.readFile();
    return {
      name: name,
      type: name === 'planet' ? 'Planet' : 'Moon',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    };
  } finally {
    await handle.close();
  }
}

exports.index = async function(req, res) {
  try {
    const names = (await fs.promises.readdir(distPath))
      .filter(allowedName)
      .sort((a, b) => a === 'planet' ? -1 : b === 'planet' ? 1 : a.localeCompare(b));
    const files = [];
    for (const name of names) {
      try {
        files.push(await fileInfo(name));
      } catch (_) {
        // Ignore non-regular, unreadable, or concurrently removed entries.
      }
    }
    res.set('Cache-Control', 'no-store');
    res.render('downloads', {title: 'Downloads', navigate: navigation(), files: files});
  } catch (err) {
    res.status(500).render('downloads', {
      title: 'Downloads', navigate: navigation(), files: [],
      error: 'Unable to list generated configuration files: ' + err.message
    });
  }
};

exports.download = async function(req, res) {
  const name = req.params.filename;
  if (!allowedName(name)) return res.sendStatus(404);

  const fullPath = path.join(distPath, name);
  let handle;
  try {
    // O_NOFOLLOW prevents a symlink in the persistent dist volume from
    // redirecting an authenticated download to identity/controller secrets.
    handle = await fs.promises.open(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return res.sendStatus(404);
    }

    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') {
      await handle.close();
      return res.end();
    }
    const stream = handle.createReadStream({autoClose: true});
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return res.sendStatus(404);
    return res.sendStatus(500);
  }
};
