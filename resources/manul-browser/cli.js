#!/usr/bin/env node
/**
 * The `manul` command.
 *
 * A package that carries the engine but leaves it buried in `node_modules` is
 * only half an install: `manul run checkout.hunt` is how most people meet this
 * project. So the entry point is a shim that hands the whole command line to
 * the engine and gets out of the way — every subcommand, every flag, no wrapper
 * parsing anything it does not have to.
 */
import { spawn } from 'node:child_process';
import { findBinary } from './binary.js';
import { EngineNotFound } from './errors.js';
export function main(argv = process.argv.slice(2)) {
    let binary;
    try {
        binary = findBinary();
    }
    catch (err) {
        if (err instanceof EngineNotFound) {
            process.stderr.write(`manul: ${err.message}\n`);
            process.exitCode = 127;
            return;
        }
        throw err;
    }
    const child = spawn(binary, argv, { stdio: 'inherit' });
    child.on('error', (err) => {
        process.stderr.write(`manul: cannot run ${binary}: ${err.message}\n`);
        process.exitCode = 126;
    });
    child.on('close', (code, signal) => {
        // Mirror the shell's convention so a killed engine is distinguishable from
        // one that exited cleanly with a zero status.
        process.exitCode = signal ? 128 : (code ?? 0);
    });
}
main();
//# sourceMappingURL=cli.js.map