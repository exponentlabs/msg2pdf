const { execFile } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { verifyRaster } = require('./raster-policy.cjs');
const operations = new Set(['pdfinfo', 'pdftotext', 'pdfdetach', 'pdftoppm', 'qpdf']);
const [operation, ...args] = process.argv.slice(2);
const deadlineFixture = operation === 'deadline-fixture';
if (operation === 'raster') {
  const qpdf = process.env.B1_QPDF_BINARY || '/usr/bin/qpdf';
  const run = (decode) =>
    new Promise((resolve, reject) =>
      execFile(
        '/usr/bin/prlimit',
        [
          '--as=536870912',
          '--cpu=15',
          '--fsize=100663296',
          '--',
          qpdf,
          '--json',
          '--json-stream-data=inline',
          `--decode-level=${decode}`,
          args[0],
        ],
        { timeout: 15_000, maxBuffer: 20 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
      ),
    );
  Promise.all([run('all'), run('none')])
    .then(([decoded, encoded]) => {
      const result = verifyRaster(
        readFileSync(args[0]),
        decoded,
        encoded,
        JSON.parse(readFileSync(args[1], 'utf8')),
      );
      console.log(JSON.stringify({ stdout: JSON.stringify(result), stderr: '' }));
    })
    .catch(() => {
      console.error('RASTER_POLICY_FAILED');
      process.exitCode = 2;
    });
} else if (!operations.has(operation) && !deadlineFixture) {
  console.error('CHECKER_UNAVAILABLE');
  process.exitCode = 2;
} else {
  execFile(
    '/usr/bin/prlimit',
    [
      '--as=536870912',
      '--cpu=15',
      '--fsize=100663296',
      '--',
      deadlineFixture
        ? '/usr/bin/sleep'
        : operation === 'qpdf'
          ? process.env.B1_QPDF_BINARY || '/usr/bin/qpdf'
          : `/usr/bin/${operation}`,
      ...(deadlineFixture ? ['5'] : args),
    ],
    { timeout: deadlineFixture ? 50 : 15_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        console.error(error.killed ? 'CHECKER_TIMEOUT' : 'CHECKER_FAILED');
        process.exitCode = 2;
      } else console.log(JSON.stringify({ stdout, stderr }));
    },
  );
}
