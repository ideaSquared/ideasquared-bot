// typescript-eslint cannot load the TypeScript 7 API yet, so its packages get the TypeScript 6 API as a private
// dependency instead of the project's TypeScript (the project itself still type-checks with TypeScript 7):
// https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
// Remove this file once typescript-eslint supports TypeScript 7.
const TS6 = 'npm:@typescript/typescript6@6.0.2';

function readPackage(pkg) {
	if (pkg.name !== 'typescript-eslint' && !pkg.name?.startsWith('@typescript-eslint/')) return pkg;
	if (!pkg.peerDependencies?.typescript) return pkg;
	const { typescript, ...peers } = pkg.peerDependencies;
	return { ...pkg, peerDependencies: peers, dependencies: { ...pkg.dependencies, typescript: TS6 } };
}

module.exports = { hooks: { readPackage } };
