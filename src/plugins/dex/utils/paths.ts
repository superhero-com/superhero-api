export type Edge<E, N> = {
  data: E;
  t0: N;
  t1: N;
};

const includes =
  <N>(y: N) =>
  (t0: N, t1: N) => {
    if (t0 === y) {
      return -1;
    }
    if (t1 === y) {
      return 1;
    }
    return 0;
  };

type Graph<N extends string | number | symbol, E> = Record<
  N,
  Record<N, E | undefined> | undefined
>;

const getGraph = <E, N extends string | number | symbol>(
  start: N,
  edges: Edge<E, N>[],
): [Graph<N, E>, [N, E][]] => {
  const graph: Graph<N, E> = {} as any;
  const startEdges: [N, E][] = [];
  const addEdge = (n0: N, n1: N, data: E) => {
    if (!graph[n0]) {
      graph[n0] = {} as any;
    }
    (graph[n0] as any)[n1] = data;
  };
  for (const { t0, t1, data } of edges) {
    const hasStart = includes(start)(t0, t1);
    if (hasStart) {
      startEdges.push([hasStart === -1 ? t1 : t0, data]);
      continue;
    }
    addEdge(t0, t1, data);
    addEdge(t1, t0, data);
  }

  return [graph, startEdges];
};

export const getPaths = <E, N extends string | number | symbol>(
  start: N,
  end: N,
  edges: Edge<E, N>[],
): E[][] => {
  const [graph, startEdges] = getGraph(start, edges);
  return startEdges.reduce((acc: E[][], [middleNode, data]) => {
    //this is the direct connection
    if (middleNode === end) {
      return [[data]].concat(acc);
    }
    const middleEdge = graph[middleNode];
    const endData: E | undefined = middleEdge?.[end];
    return endData == null ? acc : acc.concat([[data, endData]]);
  }, []);
};
