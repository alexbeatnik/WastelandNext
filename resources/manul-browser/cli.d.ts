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
export declare function main(argv?: string[]): void;
//# sourceMappingURL=cli.d.ts.map