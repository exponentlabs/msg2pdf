const { execFile } = require('node:child_process');
const operations = new Set(['pdfinfo', 'pdftotext', 'pdfdetach', 'pdftoppm']);
const [operation, ...args] = process.argv.slice(2);
const deadlineFixture = operation === 'deadline-fixture';
if (!operations.has(operation) && !deadlineFixture) {
  console.error('CHECKER_UNAVAILABLE');
  process.exitCode = 2;
} else {
  execFile(
    deadlineFixture ? '/usr/bin/sleep' : `/usr/bin/${operation}`,
    deadlineFixture ? ['5'] : args,
    { timeout: deadlineFixture ? 50 : 15_000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        console.error(error.killed ? 'CHECKER_TIMEOUT' : 'CHECKER_FAILED');
        process.exitCode = 2;
      } else console.log(JSON.stringify({ stdout, stderr }));
    },
  );
}
