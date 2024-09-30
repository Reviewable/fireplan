'use strict';

const _ = require('lodash');
const esprima = require('esprima');
const escodegen = require('escodegen');
const estraverse = require('estraverse');
const clone = require('clone');
const fs = require('fs');
const {dirname} = require('path');
const jsyaml = require('js-yaml');

const BUILTINS = {
  auth: true, now: true, root: true, next: true, newData: true, prev: true, data: true, env: true,
  query: true
};

const NEW_DATA_VAL = {type: 'CallExpression', arguments: [], callee: {
  type: 'MemberExpression', computed: false, object: {type: 'Identifier', name: 'newData'},
  property: {type: 'Identifier', name: 'val'}
}};


class Compiler {
  constructor(source) {
    this.source = source;
  }

  transform() {
    this.defineFunctions();
    const tree = this.transformBranch(this.source.root, [], {}, 'root', 0);
    if (tree['.indexChildrenOn']) {
      throw new Error(
        'Indexed attributes must be nested under a wildard key: ' + tree['.indexChildrenOn']);
    }
    const encryptTree = this.extractEncryptDirectives(tree);
    return {rules: tree, firecrypt: encryptTree};
  }

  defineFunctions() {
    this.source.functions = this.source.functions || [];
    this.source.functions.push(
      {'boolean': 'next.isBoolean()'},
      {'string': 'next.isString()'},
      {'number': 'next.isNumber()'},
      {'any': 'true'}
    );
    this.functions = {};
    _.forEach(this.source.functions, definition => {
      _.forEach(definition, (body, signature) => {
        const match = signature.match(/^\s*(\w+)\s*(?:\((.*?)\))?\s*$/);
        if (!match) throw new Error('Invalid function signature: ' + signature);
        const name = match[1];
        const args = _.compact(_.map((match[2] || '').split(','), _.trim));
        _.forEach(args, arg => {
          if (arg in BUILTINS) throw new Error(`Argument name "${arg}" shadows builtin variable`);
        });
        if (name in this.functions) throw new Error('Duplicate function definition: ' + name);
        try {
          this.functions[name] = {name, args, ast: esprima.parse(body).body[0].expression};
        } catch (e) {
          e.message += ' in ' + body;
          throw e;
        }
      });
    });
    let changed = true;
    while (changed) {
      changed = false;
      _.forEach(this.functions, (fn, name) => {  // eslint-disable-line no-loop-func
        fn.ast = this.transformAst(fn.ast, fn.args);
        changed = changed || this.changed;
      });
    }
  }

  transformBranch(yaml, locals, refs, path, level) {
    const json = {};
    if (_.isString(yaml)) yaml = {'.value': yaml};
    const requiredChildren = [], indexedChildren = [];
    let indexedGrandChildren = [];
    let localRef;
    let moreAllowed = false, hasWildcard = false;
    if ('.ref' in yaml) {
      // Handle .ref first, since YAML children are not ordered.
      const value = yaml['.ref'];
      if (value.charAt[0] === '$') throw new Error(`ref name must not start with $: ${value}`);
      if (value in BUILTINS) throw new Error(`ref shadows builtin variable: ${value}`);
      if (localRef) throw new Error(`ref already set for this branch: ${value}`);
      if (refs[value]) throw new Error(`ref already in scope: ${value}`);
      localRef = value;
      refs[value] = level;
      delete yaml['.ref'];
    }
    if ('.read/write' in yaml) {
      // Split out, so we can expand with data/newData separately.
      const value = yaml['.read/write'];
      yaml['.read'] = yaml['.write'] = value;
      delete yaml['.read/write'];
    }
    _.forEach(yaml, (value, key) => {
      try {
        switch (key) {
          case '.value':
            value = value.replace(/^\s*((required|indexed|encrypted(\[.*?\])?)(\s+|$))*/, '');
            if (_.trim(value) === 'any') moreAllowed = true;
            /* fall through */
          case '.write':
            yaml[key] = this.expandExpression(value, locals, refs, level, true);
            break;
          case '.read':
            yaml[key] = this.expandExpression(value, locals, refs, level, false);
            break;
          case '.more':
            moreAllowed = value;
            break;
          default: {
            const encrypt = {};
            key = key.replace(/\/encrypted(\[.*?\])?(?=\/|$)/, (match, pattern) => {
              encrypt.key = pattern ? pattern.slice(1, -1) : '#';
              return '';
            }).replace(/\/few(?=\/|$)/, () => {
              if (key.charAt(0) !== '$') {
                throw new Error(`/few annotation applies only to $wildcard keys, not to "${key}"`);
              }
              encrypt.few = true;
              return '';
            });
            const firstChar = key.charAt(0);
            if (firstChar === '.') throw new Error('Unknown control key: ' + key);
            if (firstChar === '$') {
              if (hasWildcard) throw new Error('Only one wildcard allowed per object: ' + key);
              locals = locals.concat([key]);
              hasWildcard = true;
            }
            const constraint = value && (_.isString(value) ? value : value['.value']);
            if (constraint) {
              const match = constraint.match(/^\s*((required|indexed|encrypted(\[.*?\])?)(\s+|$))*/);
              if (match) {
                const keywords = match[0].split(/\s+/);
                if (keywords.length > 1 && _.uniq(_.map(keywords, keyword =>
                  keyword.replace(/encrypted\[.*?\]/, 'encrypted')
                )).length !== keywords.length) {
                  throw new Error(`Duplicated child property keywords: '${key} -> ${match[0]}`);
                }
                if (_.includes(keywords, 'required')) {
                  if (firstChar === '$') throw new Error('Wildcard children cannot be required');
                  requiredChildren.push(key);
                }
                if (_.includes(keywords, 'indexed')) {
                  if (firstChar === '$') {
                    indexedChildren.push('.value');
                  } else {
                    indexedGrandChildren.push(key);
                  }
                }
                _.forEach(keywords, keyword => {
                  const match2 = keyword.match(/^encrypted(\[.*?\])?$/);
                  if (!match2) return;
                  let pattern = match2[1];
                  if (pattern) pattern = pattern.slice(1, -1);
                  encrypt.value = pattern || '#';
                });
              }
            }
            // Transform *after* extracting all keywords, since processing a .value item will strip
            // it of all keywords in the original yaml tree.
            const childPath = firstChar === '$' ? `${path}[${key}]` : `${path}.${key}`;
            json[key] = this.transformBranch(value, locals, refs, childPath, level + 1);
            if (!_.isEmpty(encrypt)) json[key]['.encrypt'] = encrypt;
            if (json[key]['.indexChildrenOn']) {
              if (firstChar === '$') {
                indexedChildren.push.apply(indexedChildren, json[key]['.indexChildrenOn']);
              } else {
                indexedGrandChildren = indexedGrandChildren.concat(
                  _.map(json[key]['.indexChildrenOn'], indexKey => key + '/' + indexKey)
                );
              }
              delete json[key]['.indexChildrenOn'];
            }
          }
        }
      } catch (e) {
        if (!e.located) {
          e.message += ` (at ${path})`;
          e.located = true;
        }
        throw e;
      }
    });
    if ('.read/write' in yaml) {
      if ('.read' in yaml || '.write' in yaml) {
        throw new Error(`Cannot specify both .read/write and .read or .write (at ${path})`);
      }
      json['.read'] = json['.write'] = yaml['.read/write'];
    } else {
      if ('.read' in yaml) json['.read'] = yaml['.read'];
      if ('.write' in yaml) json['.write'] = yaml['.write'];
    }
    let validation = '';
    if ('.value' in yaml) validation = yaml['.value'];
    if (requiredChildren.length) {
      if (validation) validation = '(' + validation + ') && ';
      validation +=
        'newData.hasChildren([' +
        _.map(requiredChildren, childName => '\'' + childName + '\'').join(', ') +
        '])';
    }
    if (indexedChildren.length) json['.indexOn'] = indexedChildren;
    if (indexedGrandChildren.length) json['.indexChildrenOn'] = indexedGrandChildren;
    if (validation) json['.validate'] = validation;
    if (!moreAllowed && !hasWildcard) json.$other = {'.validate': false};
    if (localRef) delete refs[localRef];
    return json;
  }

  expandExpression(expression, locals, refs, level, newData) {
    if (_.isBoolean(expression)) expression = '' + expression;
    if (!_.isString(expression)) throw new Error('Expression expected, got: ' + expression);
    try {
      // console.log('expand', expression);
      let parsed;
      try {
        parsed = esprima.parse(expression);
      } catch (e) {
        parsed.message += ' in ' + expression;
        throw e;
      }
      const ast = this.transformAst(parsed, locals, refs, level, newData);
      // console.log(JSON.stringify(ast, null, 2));
      return this.generate(ast);
    } catch (e) {
      e.message += ' in ' + expression;
      throw e;
    }
  }

  transformAst(ast, locals, refs, level, newData) {
    this.changed = false;
    return estraverse.replace(ast, {
      enter: (node, parent) => {
        if (!node) return;
        if (node.type === 'Identifier' && !(
          parent.type === 'MemberExpression' && !parent.computed && parent.property === node ||
          parent.type === 'CallExpression' && parent.callee === node
        )) {
          switch (node.name) {
            case 'auth': case 'now':
              return;
            case 'root':
              node.output = 'snapshot'; break;
            case 'next': case 'newData':
              node.name = 'newData'; node.output = 'snapshot'; break;
            case 'prev': case 'data':
              node.name = 'data'; node.output = 'snapshot'; break;
            default: {
              if (node.name === 'oneOf' || node.name === 'env') return;
              if (_.includes(locals, node.name)) return;
              const ref = refs && refs[node.name];
              if (_.isNumber(ref)) {
                this.changed = true;
                let refNode = {
                  type: 'Identifier', name: newData ? 'newData' : 'data', output: 'snapshot'
                };
                _.times(level - ref, () => {
                  refNode = {type: 'CallExpression', arguments: [], output: 'snapshot', callee: {
                    type: 'MemberExpression', computed: false, object: refNode, property: {
                      type: 'Identifier', name: 'parent'
                    }
                  }};
                });
                return refNode;
              }
              if (node.name in this.functions) {
                this.changed = true;
                return {type: 'CallExpression', callee: node, arguments: []};
              }
              throw new Error('Unknown reference: ' + node.name);
            }
          }
        }
        if (node.type === 'CallExpression' && (
          node.callee.type === 'Identifier' && (
            node.callee.name === 'child' || node.callee.name === 'parent') ||
          node.callee.type === 'MemberExpression' && !node.callee.computed && (
            node.callee.property.name === 'child' || node.callee.property.name === 'parent')
        )) {
          node.output = 'snapshot';
        }
      },
      leave: (node, parent) => {
        if (!node) return;
        const originalNode = node;
        if (node.type === 'MemberExpression' && node.object.type === 'Identifier' &&
            node.object.name === 'env') {
          let envValue;
          if (node.computed) {
            if (node.property.type === 'Literal') {
              envValue = process.env[node.property.value];
            } else {
              throw new Error('Unable to expand env variable with computed name: ' + node.property);
            }
          } else {
            envValue = process.env[node.property.name];
          }
          envValue = envValue || '';
          node = {type: 'Literal', value: envValue, raw: envValue};
        }
        if (node.type === 'MemberExpression' && node.object.output === 'snapshot' && !(
          parent.type === 'CallExpression' && parent.callee === node
        )) {
          this.changed = true;
          node = {
            type: 'CallExpression', output: 'snapshot', callee: {
              type: 'MemberExpression', object: node.object, computed: false, property: {
                type: 'Identifier', name: 'child'
              }
            }, arguments: [node.computed ?
              node.property : {type: 'Literal', value: node.property.name, raw: node.property.name}
            ]
          };
        }
        if (node.output === 'snapshot' &&
            (parent.type !== 'MemberExpression' ||
             parent.computed && parent.property === originalNode)) {
          this.changed = true;
          node = {
            type: 'CallExpression', callee: {
              type: 'MemberExpression', object: node, computed: false, property: {
                type: 'Identifier', name: 'val'
              }
            }, arguments: []
          };
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
          if (_.includes(locals, node.callee.name)) return;
          this.changed = true;
          if (node.callee.name === 'oneOf') {
            let condition = {
              type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: node.arguments[0]
            };
            _.forEach(node.arguments.slice(1), arg => {
              condition = {type: 'LogicalExpression', operator: '||', left: condition, right: {
                type: 'BinaryExpression', operator: '==', left: NEW_DATA_VAL, right: arg
              }};
            });
            node = condition;
          } else {
            const fn = this.functions[node.callee.name];
            if (!fn) throw new Error('Call to undefined function: ' + this.generate(node));
            if (node.arguments.length !== fn.args.length) {
              throw new Error(
                'Number of arguments in call differs from signature: ' +
                `${this.generate(node)} vs ${node.callee.name}(${fn.args.join(', ')})`);
            }
            const bindings = {};
            _.forEach(_.zip(fn.args, node.arguments), pair => {
              bindings[pair[0]] = pair[1];
            });
            node = estraverse.replace(clone(fn.ast, false), {
              enter: (node2, parent2) => {
                if (!node2) return;
                if (node2.type === 'Identifier' && node2.name in bindings && !(
                  parent2.type === 'MemberExpression' && !parent2.computed &&
                  parent2.property === node2
                )) {
                  return bindings[node2.name];
                }
              }
            });
          }
        }
        return node;
      }
    });
  }

  generate(ast) {
    return escodegen.generate(ast, {format: {semicolons: false, newline: ' '}});
  }

  extractEncryptDirectives(tree) {
    if (!_.isObject(tree)) return;
    const encryptTree = {};
    _.forEach(tree, (value, key) => {
      if (key !== '.encrypt') value = this.extractEncryptDirectives(tree[key]);
      if (value) encryptTree[key] = value;
    });
    delete tree['.encrypt'];
    if (!_.isEmpty(encryptTree)) return encryptTree;
  }
}


exports.transform = function(source) {
  return new Compiler(source).transform();
};

exports.transformFile = function(input, output) {
  if (!output) output = input.replace(/\.ya?ml$/, '') + '.json';
  const rawSource = fs.readFileSync(input, 'utf8');
  const source = jsyaml.load(rawSource, {filename: input, schema: jsyaml.DEFAULT_SAFE_SCHEMA});
  const rules = exports.transform(source);
  // console.log(JSON.stringify(rules, null, 2));
  fs.mkdirSync(dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify({rules: rules.rules}, null, 2));
  if (rules.firecrypt) {
    const cryptOutput = output.replace(/\.json$/, '_firecrypt.json');
    fs.writeFileSync(cryptOutput, JSON.stringify({rules: rules.firecrypt}, null, 2));
  }
};
