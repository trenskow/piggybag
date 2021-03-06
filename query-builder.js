'use strict';

const
	caseit = require('@trenskow/caseit'),
	CustomPromise = require('@trenskow/custom-promise');

module.exports = exports = class QueryBuilder extends CustomPromise {

	constructor(table, options = {}, executor) {

		super();

		this._options = options;

		options.casing = options.casing || {};
		options.casing.db = options.casing.db || 'snake';
		options.casing.js = options.casing.hs || 'camel';

		options.defaultPrimaryKey = options.defaultPrimaryKey || 'id';

		this._table = this._dbCase(table);

		this._options.casing = {};
		this._options.casing.db = 'snake';
		this._options.casing.js = 'camel';

		this._defaultPrimaryKey = options.defaultPrimaryKey;

		this._table = this._dbCase(table);
		this._sortingKeys = [];

		this._joins = [];
		this._conditions = [];

		this._offset = 0;
		this._limit = Infinity;

		this._executor = executor;

		this._immediate = setImmediate(() => {
			this._exec()
				.then((result) => {
					this._resolve(result);
				})
				.catch((error) => {
					this._reject(error);
				});
		});

	}

	_dbCase(input, quote) {
		return input
			.split(/"|'/)
			.map((part, idx) => {
				if (idx % 2 == 1) return part;
				return part
					.split('.')
					.map((part) => {
						let doQuote = quote;
						if (part.substr(0,1) === '!' && quote) {
							part = part.substr(1);
							doQuote = false;
						}
						const cased = caseit(part, this._options.casing.db);
						if (doQuote) return `"${cased}"`;
						return cased;
					})
					.join('.');
			})
			.join('');
	}

	select(keys = ['*']) {
		if (!Array.isArray(keys)) keys = keys.split(/, ?/);
		this._selectKeys = (this._selectKeys || []).concat(keys);
		return this;
	}

	groupBy(element) {
		this._groupBy = element;
		return this;
	}

	count(key = 'id') {
		this._selectKeys = [`:count(${this._table}.${this._dbCase(key)})::int as count`];
		return this.first('count', { select: false });
	}

	_deconstructKeyValues(keysAndValues) {
		if (!keysAndValues) throw new TypeError('Keys and values must be provided.');
		if (typeof keysAndValues !== 'object') throw new TypeError('Keys and values must be an object.');
		let keys = [];
		let values = [];
		Object.keys(keysAndValues).forEach((key) => {
			keys.push(key);
			values.push(keysAndValues[key]);
		});
		return [keys, values];
	}

	update(keysAndValues) {
		this._command = 'update';
		[this._updateKeys, this._updateValues] = this._deconstructKeyValues(keysAndValues);
		this._transaction = true;
		return this.first();
	}

	insert(keysAndValues = {}) {
		this._command = 'insert';
		[this._insertKeys, this._insertValues] = this._deconstructKeyValues(keysAndValues);
		this._transaction = true;
		return this.first();
	}

	delete() {
		this._command = 'delete';
		this._transaction = true;
		return this;
	}

	sorted(keys) {
		if (!Array.isArray(keys)) keys = keys.split(/, ?/);
		this._sortingKeys = keys;
		return this;
	}

	offsetBy(offset = 0) {
		this._offset = offset;
		return this;
	}

	limitTo(limit = Infinity) {
		this._limit = limit;
		return this;
	}

	paginated(options) {
		if (!options) return this;
		this.offsetBy(options.offset);
		this.limitTo(options.limit || options.count);
		this._paginated = true;
		return this;
	}

	_formalizeConditions(conditions) {
		if (!conditions) throw new TypeError('Conditions must be provided.');
		if (Array.isArray(conditions)) {
			return [].concat(...conditions.map((conditions) => {
				return this._formalizeConditions(conditions);
			}));
		} else {
			if (typeof conditions !== 'object') throw new TypeError('Conditions must be an object.');
			return Object.keys(conditions).map((key) => {
				let obj = {};
				const dbKey = this._dbCase(key);
				if (conditions[key] == null) {
					obj[dbKey] = null;
				} else if (typeof conditions[key] === 'object' && !(conditions[key] instanceof Date)) {
					obj[dbKey] = this._formalizeConditions(conditions[key]);
				} else {
					obj[dbKey] = conditions[key];
				}
				return obj;
			});
		}
	}

	where(conditions) {
		this._conditions = this._conditions.concat(this._formalizeConditions(conditions));
		return this;
	}

	join(options) {
		if (!Array.isArray(options)) options = [options];
		this._joins.push(
			...options
				.filter((options) => options)
				.map((options) => {
					if (typeof options !== 'object') throw new TypeError('Option must be an object');
					if (!options.table) throw new SyntaxError('Missing table.');
					if (!options.conditions) {
						options.conditions = {};
						options.local = options.local || this._defaultPrimaryKey;
						options.foreign = options.foreign || this._defaultPrimaryKey;
						let local = options.local.substr(0,1) == ':' ? this._dbCase(options.local) : `:${this._table}.${this._dbCase(options.local)}`;
						let foreign = options.foreign.substr(0,1) == ':' ? this._dbCase(options.foreign.substr(1)) : `${this._dbCase(options.table)}.${this._dbCase(options.foreign)}`;
						options.conditions[local] = foreign;
					}
					options.conditions = this._formalizeConditions(options.conditions);
					options.required = options.required || 'both';
					if (!['none','local','foreign','both'].includes(options.required)) {
						throw new TypeError('Only `none`, `local`, `foreign`, `both` are supported by `options.required`.');
					}
					return options;
				}));
		return this;
	}

	first(key, options = { select: true }) {
		this._limit = 1;
		if (key) {
			if (options.select) this.select(key);
			this._first = key;
		}
		else this._first = true;
		return this;
	}

	onConflict(keys, action) {

		if (this._command !== 'insert') throw new Error('`onConflict` is only available when inserting.');

		if (!Array.isArray(keys)) keys = keys.split(/, ?/);

		switch (Object.keys(action || {})[0] || 'nothing') {
			case 'nothing':
				break;
			case 'update': {
				const [keys, values] = this._deconstructKeyValues(action.update);
				action.update = { keys, values };
				break;
			}
			default:
				throw new Error('Action `update` is only supported at this moment.');
		}

		this._onConflict = {
			keys,
			action
		};

		return this;

	}

	_canQuote(key) {
		if (key === '*') return false;
		if (key.toLowerCase().includes(' as ')) return false;
		if (key.includes('(')) return false;
		return true;
	}

	_buildKeys(keys = ['*'], quote) {
		return keys.map((key) => {
			if (key.substr(0,1) == ':') return key.substr(1);
			let as = key.split(':');
			if (as.length == 1) return this._dbCase(as[0], quote && this._canQuote(key));
			return `${this._dbCase(as[0], quote)} as ${this._dbCase(as[1])}`;
		}).concat(this._paginated ? 'count(*) over() as total' : []).join(', ');
	}

	get _operatorMap() {
		return {
			'$or': 'or',
			'$and': 'and'
		};
	}

	get _comparerMap() {
		return {
			'$eq': '=',
			'$ne': '!=',
			'$lt': '<',
			'$lte': '<=',
			'$gt': '>',
			'$gte': '>=',
			'$regexp': '~*'
		};
	}

	_buildConditions(conditions, operator = '$and', comparer = '$eq', wrap = true) {

		if (!conditions) throw new TypeError('No conditions provided.');

		const result = conditions.map((condition) => {

			let key = Object.keys(condition)[0];

			if (key.substr(0, 1) == '$') {
				switch (key) {
					case '$or':
					case '$and':
						return this._buildConditions(condition[key], key, comparer, true);
					case '$eq':
					case '$ne':
					case '$lt':
					case '$lte':
					case '$gt':
					case '$gte':
					case '$regexp':
						return this._buildConditions(condition[key], operator, key, true);
					default:
						throw new TypeError(`Unknown modifier ${key}.`);
				}
			}

			if (key.substr(0, 1) == ':') {
				return `${key.substr(1)} ${this._comparerMap[comparer]} ${this._dbCase(condition[key])}`;
			}

			let dbKey = key;

			if (dbKey.indexOf('.') == -1) {
				if (dbKey.substr(0,1) === '!') {
					dbKey = dbKey.substr(1);
				} else {
					dbKey = `"${dbKey}"`;
				}
			}

			if (condition[key] == null) {
				switch (comparer) {
					case '$eq':
						return `${dbKey} is null`;
					case '$ne':
						return `${dbKey} is not null`;
					default:
						throw new TypeError(`Modifier ${comparer} is not usable with \`null\` values.`);
				}
			}

			this._queryParameters.push(condition[key]);

			return `${dbKey} ${this._comparerMap[comparer]} $${this._queryParameters.length}`;

		}).filter((part) => part.length).join(` ${this._operatorMap[operator]} `);
		if (wrap && result.length) return `(${result})`;
		return result;

	}

	_buildWhere(conditions) {
		conditions = conditions || this._conditions;
		if (!conditions.length) return;
		const result = this._buildConditions(conditions);
		if (!result.length) return '';
		return `where ${result}`;
	}

	_buildJoins() {
		return this._joins.map((join) => {
			if (join.conditions) {
				let type;
				switch (join.required) {
					case 'both': type = 'join'; break;
					case 'local': type = 'left join'; break;
					case 'foreign': type = 'right join'; break;
					case 'none': type = 'outer join'; break;
				}
				return `${type} ${this._dbCase(join.table)} on ${this._buildConditions(join.conditions)}`;
			} else {
				return `cross join ${this._dbCase(join.table)}`;
			}
		}).join(' ');
	}

	_buildSorting() {
		if (!this._sortingKeys.length) return;
		const escapeIfNeeded = (value) => {
			if (value.substr(0, 1) == ':') return value.substr(1);
			return this._dbCase(value, true);
		};
		return `order by ${this._sortingKeys.map((key) => {
			if (key.substr(0, 1) == '-') return `${escapeIfNeeded(key.substr(1))} desc`;
			return escapeIfNeeded(key);
		}).join(', ')}`;
	}

	_buildOffset() {
		if (!this._offset) return;
		return `offset ${this._offset}`;
	}

	_buildLimit() {
		if ((this._limit || Infinity) == Infinity) return;
		return `limit ${this._limit}`;
	}

	_buildUpdateKeysAndValues(keys, values) {
		return `set ${keys.map((key, idx) => {
			let value = values[idx];
			if (value == null) {
				value = 'null';
			} else if (/^:/.test(value)) {
				value = value.substr(1);
			} else {
				this._queryParameters.push(value);
				value = `$${this._queryParameters.length}`;
			}
			return `${this._dbCase(key, true)} = ${value}`;
		}).join(', ')}`;
	}

	_buildUpdate(keys, values) {
		return this._buildUpdateKeysAndValues(keys || this._updateKeys, values || this._updateValues);
	}

	_buildInsertValues() {
		return this._insertValues.map((value) => {
			this._queryParameters.push(value);
			return `$${this._queryParameters.length}`;
		}).join(', ');
	}

	_buildInsert() {
		if (!Object.keys(this._insertKeys).length) return 'default values';
		return `(${this._buildKeys(this._insertKeys, true)}) values (${this._buildInsertValues()})`;
	}

	_buildGroup() {
		if (!this._groupBy) return '';
		return `group by ${this._dbCase(this._groupBy)}`;
	}

	_buildOnConflict() {
		if (!this._onConflict) return '';
		let result = `on conflict (${this._buildKeys(this._onConflict.keys, true)}) do `;
		switch (Object.keys(this._onConflict.action || {})[0] || 'nothing') {
			case 'nothing':
				result += 'nothing';
			case 'update':
				result += `update ${this._buildUpdateKeysAndValues(this._onConflict.action.update.keys, this._onConflict.action.update.values)}`;
				break;
			default:
				break;
		}
		return result;
	}

	_build() {

		this._queryParameters = [];

		const command = this._command || 'select';

		let parts = [command];

		switch (command) {
			case 'select':
				parts = parts.concat([
					this._buildKeys(this._selectKeys, true),
					'from',
					this._table,
					this._buildJoins(),
					this._buildWhere(),
					this._buildGroup(),
					this._buildSorting(),
					this._buildOffset(),
					this._buildLimit()
				]);
				break;
			case 'update':
				parts = parts.concat([
					this._table,
					this._buildUpdate(),
					this._buildWhere(),
					'returning',
					this._buildKeys(this._selectKeys, true)
				]);
				break;
			case 'insert':
				parts = parts.concat([
					'into',
					this._table,
					this._buildInsert(),
					this._buildOnConflict(),
					'returning',
					this._buildKeys(this._selectKeys, true)
				]);
				break;
			case 'delete':
				parts = parts.concat([
					'from',
					this._table,
					this._buildWhere()
				]);
				break;
		}

		return [parts.filter((part) => part && part.length).join(' '), this._queryParameters];

	}

	async _exec() {
		const rows = await this._executor(this);
		if (this._paginated && !this._first) {
			let total;
			if (rows.length == 0) {
				delete this._paginated;
				delete this._offset;
				delete this._limit;
				this._sortingKeys = [];
				total = parseInt(await this.count('*')._exec());
			} else {
				total = parseInt(((rows || [])[0] || {})['total'] || 0);
			}
			rows.forEach((item) => delete item.total);
			return { total, items: rows };
		}
		return rows;
	}

	exec() {
		return this;
	}

};
