import { ClientSession, ObjectId } from 'mongodb';
import {
  DatabaseDriver, EntityData, AnyEntity, FilterQuery, EntityMetadata, EntityProperty, Configuration, Utils, ReferenceType, FindOneOptions, FindOptions,
  QueryResult, Transaction, IDatabaseDriver, EntityManager, EntityManagerType, Dictionary, PopulateOptions,
} from '@mikro-orm/core';
import { MongoConnection } from './MongoConnection';
import { MongoPlatform } from './MongoPlatform';
import { MongoEntityManager } from './MongoEntityManager';

export class MongoDriver extends DatabaseDriver<MongoConnection> {

  [EntityManagerType]: MongoEntityManager<this>;

  protected readonly connection = new MongoConnection(this.config);
  protected readonly platform = new MongoPlatform();

  constructor(config: Configuration) {
    super(config, ['mongodb']);
  }

  createEntityManager<D extends IDatabaseDriver = IDatabaseDriver>(useContext?: boolean): D[typeof EntityManagerType] {
    return new MongoEntityManager(this.config, this, this.metadata, useContext) as unknown as EntityManager<D>;
  }

  async find<T extends AnyEntity<T>>(entityName: string, where: FilterQuery<T>, options: FindOptions<T> = {}, ctx?: Transaction<ClientSession>): Promise<T[]> {
    const fields = this.buildFields(entityName, options.populate as PopulateOptions<T>[] || [], options.fields);
    where = this.renameFields(entityName, where);
    const res = await this.rethrow(this.getConnection('read').find<T>(entityName, where, options.orderBy, options.limit, options.offset, fields, ctx));

    return res.map((r: T) => this.mapResult<T>(r, this.metadata.find(entityName)!)!);
  }

  async findOne<T extends AnyEntity<T>>(entityName: string, where: FilterQuery<T>, options: FindOneOptions<T> = { populate: [], orderBy: {} }, ctx?: Transaction<ClientSession>): Promise<T | null> {
    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    const fields = this.buildFields(entityName, options.populate as PopulateOptions<T>[] || [], options.fields);
    where = this.renameFields(entityName, where);
    const res = await this.rethrow(this.getConnection('read').find<T>(entityName, where, options.orderBy, 1, undefined, fields, ctx));

    return this.mapResult<T>(res[0], this.metadata.find(entityName)!);
  }

  async count<T extends AnyEntity<T>>(entityName: string, where: FilterQuery<T>, ctx?: Transaction<ClientSession>): Promise<number> {
    where = this.renameFields(entityName, where);
    return this.rethrow(this.getConnection('read').countDocuments(entityName, where, ctx));
  }

  async nativeInsert<T extends AnyEntity<T>>(entityName: string, data: EntityData<T>, ctx?: Transaction<ClientSession>): Promise<QueryResult> {
    data = this.renameFields(entityName, data);
    return this.rethrow(this.getConnection('write').insertOne(entityName, data as { _id: any }, ctx));
  }

  async nativeInsertMany<T extends AnyEntity<T>>(entityName: string, data: EntityData<T>[], ctx?: Transaction<ClientSession>): Promise<QueryResult> {
    data = data.map(d => this.renameFields(entityName, d));
    return this.rethrow(this.getConnection('write').insertMany(entityName, data as any[], ctx));
  }

  async nativeUpdate<T extends AnyEntity<T>>(entityName: string, where: FilterQuery<T>, data: EntityData<T>, ctx?: Transaction<ClientSession>): Promise<QueryResult> {
    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    where = this.renameFields(entityName, where);
    data = this.renameFields(entityName, data);

    return this.rethrow(this.getConnection('write').updateMany(entityName, where as FilterQuery<T>, data as { _id: any }, ctx));
  }

  async nativeDelete<T extends AnyEntity<T>>(entityName: string, where: FilterQuery<T>, ctx?: Transaction<ClientSession>): Promise<QueryResult> {
    if (Utils.isPrimaryKey(where)) {
      where = this.buildFilterById(entityName, where as string);
    }

    where = this.renameFields(entityName, where);

    return this.rethrow(this.getConnection('write').deleteMany(entityName, where, ctx));
  }

  async aggregate(entityName: string, pipeline: any[], ctx?: Transaction<ClientSession>): Promise<any[]> {
    return this.rethrow(this.getConnection('read').aggregate(entityName, pipeline, ctx));
  }

  async createCollections(): Promise<void> {
    const existing = await this.getConnection('write').listCollections();

    const promises = Object.values(this.metadata.getAll())
      .filter(meta => !existing.includes(meta.collection))
      .map(meta => this.getConnection('write').createCollection(meta.collection));

    await this.rethrow(Promise.all(promises));
  }

  async dropCollections(): Promise<void> {
    const db = this.getConnection('write').getDb();
    const collections = await this.rethrow(db.listCollections().toArray());
    const existing = collections.map(c => c.name);
    const promises = Object.values(this.metadata.getAll())
      .filter(meta => existing.includes(meta.collection))
      .map(meta => this.getConnection('write').dropCollection(meta.collection));

    await this.rethrow(Promise.all(promises));
  }

  async ensureIndexes(): Promise<void> {
    await this.rethrow(this.createCollections());
    const promises: Promise<string>[] = [];

    for (const meta of Object.values(this.metadata.getAll())) {
      promises.push(...this.createIndexes(meta));
      promises.push(...this.createUniqueIndexes(meta));

      for (const prop of Object.values(meta.properties)) {
        promises.push(...this.createPropertyIndexes(meta, prop, 'index'));
        promises.push(...this.createPropertyIndexes(meta, prop, 'unique'));
      }
    }

    await this.rethrow(Promise.all(promises));
  }

  private createIndexes(meta: EntityMetadata) {
    const promises: Promise<string>[] = [];
    meta.indexes.forEach(index => {
      let fieldOrSpec: string | Dictionary;
      const properties = Utils.flatten(Utils.asArray(index.properties).map(prop => meta.properties[prop].fieldNames));
      const collection = this.getConnection('write').getCollection(meta.name);

      if (index.options && properties.length === 0) {
        return promises.push(collection.createIndex(index.options));
      }

      if (index.type) {
        const spec: Dictionary<string> = {};
        properties.forEach(prop => spec[prop] = index.type!);
        fieldOrSpec = spec;
      } else {
        fieldOrSpec = properties.reduce((o, i) => { o[i] = 1; return o; }, {});
      }

      promises.push(collection.createIndex(fieldOrSpec, {
        name: index.name,
        unique: false,
        ...(index.options || {}),
      }));
    });

    return promises;
  }

  private createUniqueIndexes(meta: EntityMetadata) {
    const promises: Promise<string>[] = [];
    meta.uniques.forEach(index => {
      const properties = Utils.flatten(Utils.asArray(index.properties).map(prop => meta.properties[prop].fieldNames));
      const fieldOrSpec = properties.reduce((o, i) => { o[i] = 1; return o; }, {});
      promises.push(this.getConnection('write').getCollection(meta.name).createIndex(fieldOrSpec, {
        name: index.name,
        unique: true,
        ...(index.options || {}),
      }));
    });

    return promises;
  }

  private createPropertyIndexes(meta: EntityMetadata, prop: EntityProperty, type: 'index' | 'unique') {
    if (!prop[type]) {
      return [];
    }

    const fieldOrSpec = prop.fieldNames.reduce((o, i) => { o[i] = 1; return o; }, {});

    return [this.getConnection('write').getCollection(meta.name).createIndex(fieldOrSpec, {
      name: (Utils.isString(prop[type]) ? prop[type] : undefined) as string,
      unique: type === 'unique',
      sparse: prop.nullable === true,
    })];
  }

  private renameFields<T>(entityName: string, data: T): T {
    data = Object.assign({}, data); // copy first
    Utils.renameKey(data, 'id', '_id');
    const meta = this.metadata.find(entityName);

    if (meta) {
      this.inlineEmbeddables(meta, data);
    }

    Object.keys(data).forEach(k => {
      if (meta?.properties[k]) {
        const prop = meta.properties[k];

        if (prop.fieldNames) {
          Utils.renameKey(data, k, prop.fieldNames[0]);
        }

        let isObjectId: boolean;

        if (prop.reference === ReferenceType.SCALAR) {
          isObjectId = prop.type.toLowerCase() === 'objectid';
        } else {
          const meta2 = this.metadata.find(prop.type)!;
          const pk = meta2.properties[meta2.primaryKeys[0]];
          isObjectId = pk.type.toLowerCase() === 'objectid';
        }

        if (isObjectId) {
          data[k] = this.convertObjectIds(data[k]);
        }
      }

      if (Utils.isPlainObject(data[k]) && '$re' in data[k]) {
        data[k] = new RegExp(data[k].$re);
      }
    });

    return data;
  }

  private convertObjectIds<T extends ObjectId | Dictionary | any[]>(data: T): T {
    if (data instanceof ObjectId) {
      return data;
    }

    if (Utils.isString(data) && data.match(/^[0-9a-f]{24}$/i)) {
      return new ObjectId(data) as T;
    }

    if (Array.isArray(data)) {
      return data.map((item: any) => this.convertObjectIds(item)) as T;
    }

    if (Utils.isObject(data)) {
      Object.keys(data).forEach(k => {
        data[k] = this.convertObjectIds(data[k]);
      });
    }

    return data;
  }

  private buildFilterById<T extends AnyEntity<T>>(entityName: string, id: string): FilterQuery<T> {
    const meta = this.metadata.find(entityName)!;


    if (meta.properties[meta.primaryKeys[0]].type.toLowerCase() === 'objectid') {
      return { _id: new ObjectId(id) } as FilterQuery<T>;
    }


    return { _id: id } as FilterQuery<T>;
  }

  private buildFields<T>(entityName: string, populate: PopulateOptions<T>[], fields?: string[]): string[] | undefined {
    const meta = this.metadata.find(entityName)!;
    const props = Object.values<EntityProperty<T>>(meta.properties).filter(prop => this.shouldHaveColumn(prop, populate));
    const lazyProps = Object.values<EntityProperty<T>>(meta.properties).filter(prop => prop.lazy && !populate.some(p => p.field === prop.name));

    if (fields) {
      fields.unshift(...meta.primaryKeys.filter(pk => !fields!.includes(pk)));
    } else if (lazyProps.length > 0) {
      fields = Utils.flatten(props.filter(p => !lazyProps.includes(p)).map(p => p.fieldNames));
    }

    return fields;
  }

  protected shouldHaveColumn<T>(prop: EntityProperty<T>, populate: PopulateOptions<T>[]): boolean {
    if (super.shouldHaveColumn(prop, populate)) {
      return true;
    }

    return prop.reference === ReferenceType.MANY_TO_MANY && prop.owner;
  }

}
