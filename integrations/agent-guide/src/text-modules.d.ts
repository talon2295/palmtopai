/** Text files imported with `with { type: 'text' }` (inlined by the bundler). */
declare module '*.md' {
    const content: string;
    export default content;
}
