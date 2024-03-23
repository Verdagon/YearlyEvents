import knexBuilder from 'knex';

export function connectKnex(dbPath) {
  const knex = knexBuilder({
    client: 'sqlite3', // or 'better-sqlite3'
    connection: {
      filename: dbPath
    },
    useNullAsDefault: true
  });
  return knex;
}

export async function getFromDb(knex, tableName, cacheCounter, where, jsonFields) {
  let response =
    await knex
      .select()
      .from(tableName)
      .where(where)
      .limit(1);
  if (response.length == 0 || response[0] == null) {
    return null;
  }
  cacheCounter.count++;
  const result = response[0];
  for (const jsonField of (jsonFields || [])) {
    result[jsonField] = JSON.parse(result[jsonField]);
  }
  return result;
}

// export async function addToCacheDb(knex, tableName, cacheKeyMap, result) {
//     await knex.into(tableName).insert(row);  
// }

export async function dbCachedZ(knex, tableName, cacheCounter, cacheKeyMap, inner, transform, cacheIf, jsonFields) {
  try {
    const untransformedResult =
        await getFromDb(
            knex, tableName, cacheCounter, cacheKeyMap, jsonFields);
    if (untransformedResult == null) {
      throw null;
    }
    try {
      const transformedResult = await transform(untransformedResult);
      console.log("Reusing result from cache.");
      cacheCounter.count++;
      return transformedResult;
    } catch (reason) {
      console.log("Not using result from cache: ", reason);
      throw null;
    }
  } catch (readFileError) {
    const result = await inner();
    if (typeof result != 'object') {
      throw "dbCached inner result must be an object!";
    }
    if (cacheIf(result)) {
      knex.into(tableName).insert(result);
    }
    return result;
  }
}
