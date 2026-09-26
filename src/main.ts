import './ui/styles.css';
import { buildGraph } from './core/graph';
import { validateNetwork } from './core/validate';
import { umeda } from './data/umeda';
import { App } from './ui/app';

const graph = buildGraph(umeda.network);
const problems = validateNetwork(graph);
if (problems.length) console.warn('[umeda-transfer-3d] network issues:', problems);

new App(graph, umeda);
