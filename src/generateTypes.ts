import { Project, SyntaxKind, Node } from "ts-morph";
import * as fs from "fs";

const project = new Project({
    compilerOptions: { allowJs: true }
});

// Add input files
const inputPattern = "input/**/*.js";
project.addSourceFilesAtPaths(inputPattern);

const sourceFiles = project.getSourceFiles();
console.log(`Found ${sourceFiles.length} files.`);

interface TypeDefinition {
    kind: 'namespace' | 'class';
    name: string;
    memberOf?: string;
    properties?: any[];
    methods?: any[];
}

const definitions: Record<string, TypeDefinition> = {};

function getTagComment(tag: any): string {
    const comment = tag.getComment();
    if (typeof comment === 'string') return comment;
    if (Array.isArray(comment)) return comment.map((c: any) => c.getText()).join('');
    return '';
}

function parseName(comment: string): string | undefined {
    return comment.split(' ')[0].trim();
}

sourceFiles.forEach(file => {
    file.forEachDescendant(node => {
        // @ts-ignore
        const jsDocs = node.getJsDocs ? node.getJsDocs() : [];
        if (jsDocs.length === 0) return;

        for (const doc of jsDocs) {
            const tags = doc.getTags();
            
            const namespaceTag = tags.find((t: any) => t.getTagName() === 'namespace');
            if (namespaceTag) {
                const name = parseName(getTagComment(namespaceTag));
                if (name) {
                    if (!definitions[name]) {
                        definitions[name] = { kind: 'namespace', name, members: [] } as any;
                    }
                }
            }

            const classTag = tags.find((t: any) => t.getTagName() === 'class');
            if (classTag) {
                const className = parseName(getTagComment(classTag));
                const memberOfTag = tags.find((t: any) => t.getTagName() === 'memberof');
                const memberOf = memberOfTag ? parseName(getTagComment(memberOfTag)) : undefined;

                if (className) {
                    const classDef: TypeDefinition = {
                        kind: 'class',
                        name: className,
                        memberOf: memberOf,
                        properties: [],
                        methods: []
                    };

                    let funcNode: Node | undefined = node;
                    if (Node.isVariableStatement(node)) {
                        const decl = node.getDeclarations()[0];
                        if (decl) funcNode = decl.getInitializer();
                    }
                    
                    if (funcNode && (Node.isFunctionExpression(funcNode) || Node.isFunctionDeclaration(funcNode))) {
                        funcNode.getBody()?.forEachChild(child => {
                            if (Node.isExpressionStatement(child)) {
                                const expr = child.getExpression();
                                if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
                                    const left = expr.getLeft();
                                    const right = expr.getRight();
                                    
                                    if (Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword) {
                                        const propName = left.getName();
                                        
                                        if (Node.isFunctionExpression(right) || Node.isArrowFunction(right)) {
                                            const params = right.getParameters().map(p => ({
                                                name: p.getName(),
                                                type: 'any'
                                            }));
                                            classDef.methods?.push({ name: propName, params });
                                        } else if (Node.isObjectLiteralExpression(right)) {
                                            const props = right.getProperties().map(p => {
                                                if (Node.isPropertyAssignment(p)) {
                                                    const init = p.getInitializer();
                                                    let type = 'any';
                                                    if (init) {
                                                        if (init.getKind() === SyntaxKind.StringLiteral) type = 'string';
                                                        else if (init.getKind() === SyntaxKind.NumericLiteral) type = 'number';
                                                        else if (init.getKind() === SyntaxKind.TrueKeyword || init.getKind() === SyntaxKind.FalseKeyword) type = 'boolean';
                                                    }
                                                    return { name: p.getName(), type };
                                                }
                                                return { name: p.getText(), type: 'any' };
                                            });
                                            
                                            classDef.properties?.push({ 
                                                name: propName, 
                                                type: `{ ${props.map(p => `${p.name}: ${p.type}`).join('; ')} }`
                                            });
                                        } else {
                                            classDef.properties?.push({ name: propName, type: 'any' });
                                        }
                                    }
                                }
                            }
                        });
                    }

                    if (!definitions[className]) {
                        definitions[className] = classDef;
                    } else {
                        Object.assign(definitions[className], classDef);
                    }
                }
            }
        }
    });
});

let output = "";

function generateClass(def: any, indent: string = "") {
    let s = `${indent}class ${def.name} {\n`;
    def.properties.forEach((p: any) => {
        s += `${indent}  ${p.name}: ${p.type};\n`;
    });
    def.methods.forEach((m: any) => {
        const params = m.params.map((p: any) => `${p.name}: ${p.type}`).join(', ');
        s += `${indent}  ${m.name}(${params}): void;\n`;
    });
    s += `${indent}}\n`;
    return s;
}

Object.keys(definitions).forEach(key => {
    const def = definitions[key];
    if (def.kind === 'namespace') {
        output += `declare namespace ${key} {\n`;
        Object.values(definitions).forEach((member: any) => {
            if (member.kind === 'class' && member.memberOf === key) {
                output += generateClass(member, "  ");
            }
        });
        output += `}\n`;
    } else if (def.kind === 'class' && !def.memberOf) {
        // Top level class if any
        output += `declare ${generateClass(def)}`;
    }
});

fs.writeFileSync('types.d.ts', output);
console.log("types.d.ts generated");
