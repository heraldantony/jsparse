import { Project, SyntaxKind, Node, SourceFile } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

const project = new Project({
    compilerOptions: { allowJs: true }
});

const inputPattern = "input/**/*.js";
project.addSourceFilesAtPaths(inputPattern);
const sourceFiles = project.getSourceFiles();

interface PropDef {
    name: string;
    type: string;
    isMethod?: boolean;
    params?: { name: string, type: string }[];
    refPath?: string;
}

interface ModuleExport {
    kind: 'class' | 'object' | 'unknown';
    name?: string;
    props: PropDef[];
    filePath: string;
    jsDocName?: string;
    jsDocKind?: 'namespace' | 'class';
    jsDocMemberOf?: string;
}

const registry: Record<string, ModuleExport> = {};

function resolveRequirePath(currentFile: string, requirePath: string): string {
    const dir = path.dirname(currentFile);
    let resolved = path.resolve(dir, requirePath);
    if (!fs.existsSync(resolved) && fs.existsSync(resolved + '.js')) {
        resolved += '.js';
    }
    return resolved;
}

sourceFiles.forEach(file => {
    const filePath = path.resolve(file.getFilePath());
    registry[filePath] = analyzeFile(file);
});

function analyzeFile(file: SourceFile): ModuleExport {
    const filePath = path.resolve(file.getFilePath());
    const exportDef: ModuleExport = {
        kind: 'unknown',
        props: [],
        filePath
    };

    // JSDoc Analysis
    file.forEachDescendant(node => {
        // @ts-ignore
        const jsDocs = node.getJsDocs ? node.getJsDocs() : [];
        for (const doc of jsDocs) {
            const tags = doc.getTags();
            const nsTag = tags.find((t: any) => t.getTagName() === 'namespace');
            if (nsTag) {
                exportDef.jsDocKind = 'namespace';
                exportDef.jsDocName = nsTag.getCommentText()?.split(' ')[0].trim();
            }
            const classTag = tags.find((t: any) => t.getTagName() === 'class');
            if (classTag) {
                exportDef.jsDocKind = 'class';
                exportDef.jsDocName = classTag.getCommentText()?.split(' ')[0].trim();
            }
            const memberOf = tags.find((t: any) => t.getTagName() === 'memberof');
            if (memberOf) {
                exportDef.jsDocMemberOf = memberOf.getCommentText()?.split(' ')[0].trim();
            }
        }
    });

    // Code Analysis
    let exportsAssign: Node | undefined;
    file.forEachDescendant(node => {
        if (Node.isBinaryExpression(node) && 
            node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
            const left = node.getLeft();
            if (Node.isPropertyAccessExpression(left) && 
                left.getExpression().getText() === 'module' && 
                left.getName() === 'exports') {
                exportsAssign = node.getRight();
            }
        }
    });

    if (exportsAssign) {
        analyzeExpression(exportsAssign, exportDef, file);
    }

    return exportDef;
}

function analyzeExpression(expr: Node, def: ModuleExport, file: SourceFile) {
    if (Node.isNewExpression(expr)) {
        const exprType = expr.getExpression();
        if (Node.isIdentifier(exprType)) {
            const name = exprType.getText();
            // @ts-ignore
            const decl = file.getFunction(name) || file.getVariableDeclaration(name);
            if (decl) {
                analyzeFunctionReturnOrThis(decl, def);
            }
        }
    } 
    else if (Node.isIdentifier(expr)) {
        const name = expr.getText();
        // @ts-ignore
        const decl = file.getFunction(name) || file.getVariableDeclaration(name);
        if (decl) {
             let funcDecl = decl;
             if (Node.isVariableDeclaration(decl)) {
                 const init = decl.getInitializer();
                 if (init && (Node.isFunctionExpression(init) || Node.isArrowFunction(init))) {
                     funcDecl = init as any;
                 }
             }
             
             if (Node.isFunctionDeclaration(funcDecl) || Node.isFunctionExpression(funcDecl)) {
                 def.kind = 'class';
                 if (!def.name) def.name = name;
                 analyzeFunctionThis(funcDecl as any, def);
             }
        }
    }
    else if (Node.isFunctionExpression(expr)) {
        def.kind = 'class';
        analyzeFunctionThis(expr, def);
    }
    else if (Node.isObjectLiteralExpression(expr)) {
        def.kind = 'object';
        analyzeObjectLiteral(expr, def);
    }
}

function analyzeFunctionReturnOrThis(func: Node, def: ModuleExport) {
    let foundReturn = false;
    func.forEachDescendant(node => {
        if (Node.isReturnStatement(node)) {
            const retExpr = node.getExpression();
            if (retExpr && Node.isObjectLiteralExpression(retExpr)) {
                def.kind = 'object';
                foundReturn = true;
                analyzeObjectLiteral(retExpr, def);
            } else if (retExpr && Node.isIdentifier(retExpr)) {
                const name = retExpr.getText();
                // @ts-ignore
                const varDecl = func.getBody().getDescendantsOfKind(SyntaxKind.VariableDeclaration).find(v => v.getName() === name);
                if (varDecl) {
                    if (!def.name) def.name = name; 
                    const init = varDecl.getInitializer();
                    if (init && Node.isObjectLiteralExpression(init)) {
                        def.kind = 'object';
                        foundReturn = true;
                        analyzeObjectLiteral(init, def);
                    }
                }
            }
        }
    });

    if (!foundReturn) {
        def.kind = 'class';
        analyzeFunctionThis(func, def);
    }
}

function analyzeFunctionThis(func: Node, def: ModuleExport) {
    func.forEachDescendant(node => {
        if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
            const left = node.getLeft();
            const right = node.getRight();
            
            if (Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword) {
                const propName = left.getName();
                const propDef: PropDef = { name: propName, type: 'any' };

                if (Node.isFunctionExpression(right) || Node.isArrowFunction(right)) {
                    propDef.isMethod = true;
                    propDef.params = right.getParameters().map(p => ({
                        name: p.getName(),
                        type: 'any'
                    }));
                    propDef.type = 'void';
                } else if (Node.isObjectLiteralExpression(right)) {
                    // @ts-ignore
                    const props = right.getProperties().map(p => {
                         if (Node.isPropertyAssignment(p)) {
                             // Simple type inference for literal values
                             const init = p.getInitializer();
                             let t = 'any';
                             if (init) {
                                 if (init.getKind() === SyntaxKind.StringLiteral) t = 'string';
                                 else if (init.getKind() === SyntaxKind.NumericLiteral) t = 'number';
                                 else if (init.getKind() === SyntaxKind.TrueKeyword || init.getKind() === SyntaxKind.FalseKeyword) t = 'boolean';
                             }
                             return `${p.getName()}: ${t}`;
                         }
                         return null;
                    }).filter(Boolean).join('; ');
                    propDef.type = `{ ${props} }`;
                }
                
                def.props.push(propDef);
            }
        }
    });
}

function analyzeObjectLiteral(obj: Node, def: ModuleExport) {
    // @ts-ignore
    obj.getProperties().forEach(prop => {
        if (Node.isPropertyAssignment(prop)) {
            const name = prop.getName();
            const init = prop.getInitializer();
            const propDef: PropDef = { name, type: 'any' };
            
            if (init) {
                if (Node.isCallExpression(init) && init.getExpression().getText() === 'require') {
                    const args = init.getArguments();
                    if (args.length > 0 && Node.isStringLiteral(args[0])) {
                        const reqPath = args[0].getLiteralText();
                        propDef.refPath = resolveRequirePath(def.filePath, reqPath);
                    }
                }
            }
            def.props.push(propDef);
        }
    });
}

// Grouping and linking
const namespaces: Record<string, ModuleExport[]> = {};
const others: ModuleExport[] = [];

// Initial sort
Object.values(registry).forEach(mod => {
    if (mod.jsDocKind === 'namespace' && mod.jsDocName) {
        if (!namespaces[mod.jsDocName]) namespaces[mod.jsDocName] = [];
        namespaces[mod.jsDocName].push(mod);
    } else if (mod.jsDocKind === 'class' && mod.jsDocMemberOf) {
         if (!namespaces[mod.jsDocMemberOf]) namespaces[mod.jsDocMemberOf] = [];
         namespaces[mod.jsDocMemberOf].push(mod);
    } else {
        others.push(mod);
    }
});

// Infer from object structure in namespaces
Object.keys(namespaces).forEach(nsName => {
    const mods = namespaces[nsName];
    // Find the 'root' object of the namespace (the one defining it)
    const root = mods.find(m => m.jsDocKind === 'namespace');
    
    if (root && root.kind === 'object') {
        root.props.forEach(prop => {
            if (prop.refPath && registry[prop.refPath]) {
                const linkedMod = registry[prop.refPath];
                // Check if already in this namespace
                const alreadyHere = mods.includes(linkedMod);
                if (!alreadyHere) {
                    // Move from others or other location
                    if (!linkedMod.name) linkedMod.name = prop.name;
                    
                    if (others.includes(linkedMod)) {
                        others.splice(others.indexOf(linkedMod), 1);
                    }
                    mods.push(linkedMod);
                }
            }
        });
    }
});

// Fallback: If 'others' contains objects with requires, they might be namespaces themselves without JSDoc
others.slice().forEach(mod => {
    if (mod.kind === 'object' && mod.props.some(p => !!p.refPath)) {
        // Treat as namespace
        const nsName = mod.name || path.basename(mod.filePath, '.js'); // Best guess
        if (!namespaces[nsName]) namespaces[nsName] = [];
        namespaces[nsName].push(mod);
        others.splice(others.indexOf(mod), 1);

        // Process its children
        mod.props.forEach(prop => {
             if (prop.refPath && registry[prop.refPath]) {
                 const linkedMod = registry[prop.refPath];
                 if (!namespaces[nsName].includes(linkedMod)) {
                     if (!linkedMod.name) linkedMod.name = prop.name;
                     if (others.includes(linkedMod)) {
                        others.splice(others.indexOf(linkedMod), 1);
                     }
                     namespaces[nsName].push(linkedMod);
                 }
             }
        });
    }
});


let output = "";

for (const [nsName, mods] of Object.entries(namespaces)) {
    output += `declare namespace ${nsName} {\n`;
    
    mods.forEach(mod => {
        // Skip the namespace container object itself if it's just a loader
        if (mod.jsDocKind === 'namespace' || (mod.kind === 'object' && mod.props.some(p => !!p.refPath))) {
            return;
        }
        generateModule(mod, "  ");
    });
    
    output += `}\n`;
}

// Generate remaining independent classes/objects
others.forEach(mod => {
    if (mod.kind === 'class') {
        output += `declare `;
        generateModule(mod, "");
    }
});

function generateModule(mod: ModuleExport, indent: string) {
    let name = mod.name || mod.jsDocName || path.basename(mod.filePath, '.js');
    name = name.replace(/\.js$/, '');

    if (mod.kind === 'class' || mod.jsDocKind === 'class') {
        output += `${indent}class ${name} {\n`;
        mod.props.forEach(p => {
             if (p.isMethod) {
                 const params = p.params?.map(par => `${par.name}: ${par.type}`).join(', ') || '';
                 output += `${indent}  ${p.name}(${params}): void;\n`;
             } else {
                 output += `${indent}  ${p.name}: ${p.type};\n`;
             }
        });
        output += `${indent}}\n`;
    }
}

fs.writeFileSync('types.d.ts', output);
console.log("types.d.ts generated");
