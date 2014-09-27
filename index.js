'use strict';

var _ = require('underscore');
var esprima = require('esprima');
var escodegen = require('escodegen');
var estraverse = require('estraverse');
var clone = require('clone');

exports.transform = function(source) {
  return new Compiler(source).transform();
};

function Compiler(source) {
  this.source = source;
}

Compiler.prototype.transform = function() {
  this.defineFunctions();
  return {rules: this.transformBranch(this.source.root, [])};
};

Compiler.prototype.defineFunctions = function() {
  this.source.functions = this.source.functions || [];
  this.source.functions.push(
    {'boolean': 'next.isBoolean()'},
    {'string': 'next.isString()'},
    {'number': 'next.isNumber()'}
  );
  this.functions = {};
  _.each(this.source.functions, function(definition) {
    _.each(definition, function(body, signature) {
      var match = signature.match(/^\s*(\w+)\s*(?:\((.*?)\))?\s*$/);
      if (!match) throw new Error('Invalid function signature: ' + signature);
      var name = match[1];
      var args = _.compact(_.map((match[2] || '').split(','), function(arg) {return arg.trim();}));
      if (name in this.functions) throw new Error('Duplicate function definition: ' + name);
      this.functions[name] = {name: name, args: args, ast: esprima.parse(body).body[0].expression};
    }, this);
  }, this);
  var changed = true;
  while (changed) {
    changed = false;
    _.each(this.functions, function(fn, name) {
      fn.ast = this.transformAst(fn.ast, fn.args);
      changed = changed || this.changed;
    }, this);
  }
};

Compiler.prototype.transformBranch = function(yaml, locals) {
  var json = {};
  if (_.isString(yaml)) yaml = {'.value': yaml};
  var requiredChildren = [];
  var moreAllowed = false, hasWildcard = false;
  _.each(yaml, function(value, key) {
    switch(key) {
      case '.value':
      case '.read':
      case '.write':
      case '.read/write':
        yaml[key] = this.expandExpression(value, locals);
        break;
      case '.more':
        moreAllowed = value;
        break;
      default:
        var firstChar = key.charAt(0);
        if (firstChar === '.') throw new Error('Unknown control key: ' + key);
        if (firstChar === '$') {
          if (hasWildcard) throw new Error('Only one wildcard allowed per object: ' + key);
          locals = locals.concat([key]);
          hasWildcard = true;
        } else {
          if (firstChar === '/') key = key.slice(1); else requiredChildren.push(key);
        }
        json[key] = this.transformBranch(value, locals);
    }
  }, this);
  if (yaml['.read/write']) {
    if (yaml['.read'] || yaml['.write']) throw new Error(
      'Cannot specify both .read/write and .read or .write');
    json['.read'] = json['.write'] = yaml['.read/write'];
  } else {
    if (yaml['.read']) json['.read'] = yaml['.read'];
    if (yaml['.write']) json['.write'] = yaml['.write'];
  }
  var validation = '';
  if (yaml['.value']) validation = yaml['.value'];
  if (requiredChildren.length) {
    if (validation) validation = '(' + validation + ') && ';
    validation +=
      'newData.hasChildren([' +
      _.map(requiredChildren, function(childName) {return "'" + childName + "'";}).join(', ') +
      '])';
  }
  if (validation) json['.validate'] = validation;
  if (!moreAllowed && !hasWildcard) json.$other = {'.validate': false};
  return json;
};

Compiler.prototype.expandExpression = function(expression, locals) {
  if (_.isBoolean(expression)) expression = '' + expression;
  if (!_.isString(expression)) throw new Error('Expression expected, got: ' + expression);
  var ast = this.transformAst(esprima.parse(expression), locals);
  // console.log(JSON.stringify(ast, null, 2));
  return this.generate(ast);
};

Compiler.prototype.transformAst = function(ast, locals) {
  this.changed = false;
  var self = this;
  return estraverse.replace(ast, {
    enter: function(node, parent) {
      if (!node) return;
      if (node.type === 'Identifier' && !(
          parent.type === 'MemberExpression' && !parent.computed && parent.property === node)) {
        switch (node.name) {
          case 'auth': case 'now': return;
          case 'root': node.output = 'snapshot'; break;
          case 'next': node.name = 'newData';  // fall through
          case 'newData': node.output = 'snapshot'; break;
          case 'prev': node.name = 'data';  // fall through
          case 'data': node.output = 'snapshot'; break;
          default:
            var local = _.contains(locals, node.name);
            if (!(local || node.name in self.functions)) {
              throw new Error('Unknown reference: ' + node.name);
            }
            if (!local && !(parent.type === 'MemberExpression' ||
                  parent.type === 'CallExpression' && parent.callee === node)) {
              this.changed = true;
              return {type: 'CallExpression', callee: node, arguments: []};
            }
        }
      }
      if (node.type === 'CallExpression' && (
          node.callee.type === 'Identifier' && node.callee.name === 'child' ||
          node.callee.type === 'MemberExpression' && !node.callee.computed &&
          node.callee.property.name === 'child'
      )) {
        node.output = 'snapshot';
      }
    },
    leave: function(node, parent) {
      if (!node) return;
      if (node.type === 'MemberExpression' && parent.type !== 'CallExpression' &&
          node.object.output === 'snapshot') {
        self.changed = true;
        node = {
          type: 'CallExpression', output: 'snapshot', callee: {
            type: 'MemberExpression', object: node.object, property: {
              type: 'Identifier', name: 'child'
            }
          }, arguments: [node.computed ?
            node.property :  {type: 'Literal', value: node.property.name, raw: node.property.name}
          ]
        };
      }
      if (node.output === 'snapshot' && parent.type !== 'MemberExpression') {
        self.changed = true;
        node = {
          type: 'CallExpression', callee: {
            type: 'MemberExpression', object: node, computed: false, property: {
              type: 'Identifier', name: 'val'
            }
          }, arguments: []
        };
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
        if (_.contains(locals, node.callee.name)) return;
        self.changed = true;
        var fn = self.functions[node.callee.name];
        if (!fn) throw new Error('Call to undefined function: ' + self.generate(node));
        if (node.arguments.length !== fn.args.length) {
          throw new Error('Number of arguments in call differs from signature: ' +
            self.generate(note) + ' vs ' + node.callee.name + '(' + fn.args.join(', ') + ')');
        }
        var bindings = {};
        _.each(_.zip(fn.args, node.arguments), function(pair) {
          bindings[pair[0]] = pair[1];
        });
        node = estraverse.replace(clone(fn.ast, false), {
          enter: function(node, parent) {
            if (!node) return;
            if (node.type === 'Identifier' && node.name in bindings && !(
                parent.type === 'MemberExpression' && !parent.computed && parent.property === node)) {
              return bindings[node.name];
            }
          }
        });
      }
      return node;
    }
  });
};

Compiler.prototype.generate = function(ast) {
  return escodegen.generate(ast, {format: {semicolons: false, newline: ' '}});
};
