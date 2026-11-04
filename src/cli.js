'use strict';

const { parseArgs, runBatch, usage } = require('./mvp');

(async () => {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const summary = await runBatch(options);
    if (summary.failed) process.exitCode = 1;
  } catch (error) {
    console.error(`错误: ${error.message}`);
    console.error(`\n${usage()}`);
    process.exitCode = 1;
  }
})();
