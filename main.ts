import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as ws from "ws";
import { EventEmitter } from "events";

import { AIR, CLOUD, BLANK_FLOOR, TREE, BUILDING, MYSTERY, ROCKS, JUNCTION, EMPTY_ROOM, CORRIDOR_X, CORRIDOR_Y, CORRIDOR_W, STAIRS, ROCK_STAIRS } from "./chunks";
import { MAZE } from "./maze";

const MAP_PATH = "map/";
const CHUNK_CACHE_TIME = 1000 * 60;

const httpsServer = https.createServer({
	cert: fs.readFileSync("/etc/letsencrypt/live/daydun.com/fullchain.pem"),
	key: fs.readFileSync("/etc/letsencrypt/live/daydun.com/privkey.pem")
});
let server = new ws.Server({
	//server: httpsServer
	noServer: true
});

class Logger {
	log(...args: any[]) {
		let time = new Date().toISOString().replace("T", " ").replace("Z", "");
		console.log(`[${time}]`, ...args);
	}
}

let logger = new Logger();

function mod(n: number, m: number): number {
	return ((n % m) + m) % m;
}

function shuffle(array: any[]) {
	for (let i = 0; i < array.length; i++) {
		let j = Math.floor(Math.random() * (array.length - i));
		[array[i], array[j]] = [array[j], array[i]];
	}
}

class Complex {
	real: number;
	imag: number;
	
	constructor(real: number, imag: number = 0) {
		this.real = real;
		this.imag = imag;
	}
	
	// TODO: Make parsing more general. Support (2+i5)(i+3+4)
	static parse(str: string): Complex | null {
		str = str.trim();
		
		let match;
		match = str.match(/^[+-]?[0-9]{1,9}$/i);
		if (match) return new Complex(parseInt(str), 0);
		
		match = str.match(/^([+-]?)([0-9]{0,9})[ij]$/i);
		if (match) {
			let num = match[2] ? parseInt(match[2]) : 1;
			if (match[1] === "-") num = -num;
			return new Complex(0, num);
		}
		
		match = str.match(/^([+-]?[0-9]{1,9})([+-])([0-9]{0,9})[ij]$/i);
		if (match) {
			let real = parseInt(match[1]);
			let imag = match[3] ? parseInt(match[3]) : 1;
			if (match[2] === "-") imag = -imag;
			return new Complex(real, imag);
		}
		
		return null;
	}
	
	static eq(a: Complex, b: Complex): boolean {
		return a.real === b.real && a.imag === b.imag;
	}
	static min(a: Complex, b: Complex): Complex {
		return new Complex(Math.min(a.real, b.real), Math.min(a.imag, b.imag));
	}
	
	is_zero(): boolean {
		return this.real === 0 && this.imag === 0;
	}
	
	plus(other: Complex): Complex {
		return new Complex(this.real + other.real, this.imag + other.imag);
	}
	minus(other: Complex): Complex {
		return new Complex(this.real - other.real, this.imag - other.imag);
	}
	times(other: Complex): Complex {
		return new Complex(this.real * other.real, this.imag * other.imag);
	}
	
	sqrt(): Complex {
		let r = Math.sqrt(this.real ** 2 + this.imag ** 2);
		
		return new Complex(Math.sqrt((r + this.real) / 2), (Math.sign(this.imag) || 1) * Math.sqrt((r - this.real) / 2));
	}
	
	floor(): Complex {
		return new Complex(Math.floor(this.real), Math.floor(this.imag));
	}
	sign(): Complex {
		return new Complex(Math.sign(this.real), Math.sign(this.imag));
	}
	
	manhattan(other: Complex): number {
		return Math.abs(this.real - other.real) + Math.abs(this.imag - other.imag);
	}
	
	toString(): string {
		if (this.real === 0) {
			if (this.imag === 0) return "0";
			if (this.imag === 1) return "i";
			if (this.imag === -1) return "-i";
			return `${this.imag}i`;
		} else {
			if (this.imag === 1) return `${this.real}+i`;
			if (this.imag === -1) return `${this.real}-i`;
			if (this.imag > 0) return `${this.real}+${this.imag}i`;
			if (this.imag < 0) return `${this.real}-${-this.imag}i`;
			return `${this.real}`;
		}
	}
}

function c2d_to_4d(x: Complex, y: Complex): [number, number, number, number] {
	return [x.real, y.real, y.imag, x.imag];
}

function block_eq(a: Block, b: Block): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/*

spawn w = 3
spawn z = 1

*/

type BlockAir = {type: "air"};
type BlockDirt = {type: "dirt"};
type BlockWood = {type: "wood"};
type BlockLeaves = {type: "leaves"};
type BlockCloud = {type: "cloud"};
type BlockRock = {type: "rock", strength: string};
type BlockTombstone = {type: "tombstone", text: string};
type BlockConcrete = {type: "concrete"};
type BlockAmethyst = {type: "amethyst"};
type BlockSpawner = {type: "spawner"};
type BlockVeilstone = {type: "veilstone", timeout: string};

type BlockSoul = {type: "soul"};
type BlockArtery = {type: "artery"};
type BlockVentricle = {type: "ventricle"}; // Boost max hp
type BlockVentrcle = {type: "ventrcle"}; // Boost imaginary max hp
type BlockBoneMarrow = {type: "bone_marrow"}; // HP regen
type BlockShield = {type: "shield"}; // Defense
type BlockSheld = {type: "sheld"}; // Defense
type BlockMultiplier = {type: "multiplier"}; // Multiply stats by 10%
type BlockSword = {type: "sword", strength: string};
type BlockPickaxe = {type: "pickaxe", strength: string};
//type BlockCasket = {type: "casket", occupied: boolean};
type BlockSpiderLegs = {type: "spider_legs"};
type BlockTelekineticOrb = {type: "telekinetic_orb"};
//type BlockBroomstick = {type: "broomstick"};
//type BlockMana = {type: "mana"};
type BlockHealthPotion = {type: "health_potion"};
type BlockCompass = {type: "compass", x: string, y: string};
type BlockHypercube = {type: "hypercube"}; // Maze
type BlockGoal = {type: "goal"};

type Block =
	BlockAir | BlockDirt | BlockWood | BlockLeaves |
	BlockCloud | BlockRock | BlockTombstone | BlockConcrete |
	BlockAmethyst | BlockSpawner | BlockVeilstone |
	BlockSoul | BlockArtery | BlockVentricle | BlockBoneMarrow |
	BlockShield | BlockSword | BlockPickaxe | BlockSpiderLegs |
	BlockTelekineticOrb | /*BlockBroomstick | BlockMana |*/ BlockHealthPotion |
	BlockVentrcle | BlockSheld | BlockMultiplier | BlockHypercube |
	BlockCompass | BlockGoal;

const PALETTE: Block[] = [
	/* 0 */ {type: "air"},
	/* 1 */ {type: "dirt"},
	/* 2 */ {type: "wood"},
	/* 3 */ {type: "leaves"},
	/* 4 */ {type: "cloud"},
	/* 5 */ {type: "concrete"},
	/* 6 */ {type: "spawner"},
	/* 7 */ {type: "amethyst"},
	/* 8 */ {type: "veilstone", timeout: "0"},
	/* 9 */ {type: "rock", strength: "0"}
];

type JsonEntity = JsonGhost | JsonPlayer | JsonMonster;
type JsonGhost = {
	type: "ghost",
	x: string, y: string
};
type JsonPlayer = {
	type: "player",
	x: string, y: string,
	name: string,
	xp: string, level: string,
	hp: string, max_hp: string,
	inventory: Record<string, Item>
};
type JsonMonster = {
	type: "monster",
	x: string, y: string,
	hp: string, max_hp: string,
	inventory: Record<string, Item>
};

type Item = Block & {count: string};

class Slot {
	item: Block;
	count: Complex;
	
	constructor(item: Block, count: Complex) {
		this.item = item;
		this.count = count;
	}
}

/*
function buildPermutationTable(random) {
	const tableSize = 512;
	const p = new Uint8Array(tableSize);
	for (let i = 0; i < tableSize / 2; i++) {
		p[i] = i;
	}
	for (let i = 0; i < tableSize / 2 - 1; i++) {
		const r = i + ~~(random() * (256 - i));
		const aux = p[i];
		p[i] = p[r];
		p[r] = aux;
	}
	for (let i = 256; i < tableSize; i++) {
		p[i] = p[i - 256];
	}
	return p;
}

const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;
const F4 = (Math.sqrt(5.0) - 1.0) / 4.0;
const G4 = (5.0 - Math.sqrt(5.0)) / 20.0;

const grad3 = new Float64Array([
	 1,  1,  0,
	-1,  1,  0,
	 1, -1,  0,
	
	-1, -1,  0,
	 1,  0,  1,
	-1,  0,  1,
	
	 1,  0, -1,
	-1,  0, -1,
	 0,  1,  1,
	
	 0, -1,  1,
	 0,  1, -1,
	 0, -1, -1
]);

function createNoise3D(random = Math.random) {
	const perm = buildPermutationTable(random);
	// precalculating these seems to yield a speedup of over 15%
	const permGrad3x = new Float64Array(perm).map(v => grad3[(v % 12) * 3]);
	const permGrad3y = new Float64Array(perm).map(v => grad3[(v % 12) * 3 + 1]);
	const permGrad3z = new Float64Array(perm).map(v => grad3[(v % 12) * 3 + 2]);
	return function noise3D(x, y, z) {
		let n0, n1, n2, n3; // Noise contributions from the four corners
		// Skew the input space to determine which simplex cell we're in
		const s = (x + y + z) * F3; // Very nice and simple skew factor for 3D
		const i = Math.floor(x + s);
		const j = Math.floor(y + s);
		const k = Math.floor(z + s);
		const t = (i + j + k) * G3;
		const X0 = i - t; // Unskew the cell origin back to (x,y,z) space
		const Y0 = j - t;
		const Z0 = k - t;
		const x0 = x - X0; // The x,y,z distances from the cell origin
		const y0 = y - Y0;
		const z0 = z - Z0;
		// For the 3D case, the simplex shape is a slightly irregular tetrahedron.
		// Determine which simplex we are in.
		let i1, j1, k1; // Offsets for second corner of simplex in (i,j,k) coords
		let i2, j2, k2; // Offsets for third corner of simplex in (i,j,k) coords
		if (x0 >= y0) {
			if (y0 >= z0) {
				i1 = 1;
				j1 = 0;
				k1 = 0;
				i2 = 1;
				j2 = 1;
				k2 = 0;
			} // X Y Z order
			else if (x0 >= z0) {
				i1 = 1;
				j1 = 0;
				k1 = 0;
				i2 = 1;
				j2 = 0;
				k2 = 1;
			} // X Z Y order
			else {
				i1 = 0;
				j1 = 0;
				k1 = 1;
				i2 = 1;
				j2 = 0;
				k2 = 1;
			} // Z X Y order
		} else { // x0<y0
			if (y0 < z0) {
				i1 = 0;
				j1 = 0;
				k1 = 1;
				i2 = 0;
				j2 = 1;
				k2 = 1;
			} // Z Y X order
			else if (x0 < z0) {
				i1 = 0;
				j1 = 1;
				k1 = 0;
				i2 = 0;
				j2 = 1;
				k2 = 1;
			} // Y Z X order
			else {
				i1 = 0;
				j1 = 1;
				k1 = 0;
				i2 = 1;
				j2 = 1;
				k2 = 0;
			} // Y X Z order
		}
		// A step of (1,0,0) in (i,j,k) means a step of (1-c,-c,-c) in (x,y,z),
		// a step of (0,1,0) in (i,j,k) means a step of (-c,1-c,-c) in (x,y,z), and
		// a step of (0,0,1) in (i,j,k) means a step of (-c,-c,1-c) in (x,y,z), where
		// c = 1/6.
		const x1 = x0 - i1 + G3; // Offsets for second corner in (x,y,z) coords
		const y1 = y0 - j1 + G3;
		const z1 = z0 - k1 + G3;
		const x2 = x0 - i2 + 2.0 * G3; // Offsets for third corner in (x,y,z) coords
		const y2 = y0 - j2 + 2.0 * G3;
		const z2 = z0 - k2 + 2.0 * G3;
		const x3 = x0 - 1.0 + 3.0 * G3; // Offsets for last corner in (x,y,z) coords
		const y3 = y0 - 1.0 + 3.0 * G3;
		const z3 = z0 - 1.0 + 3.0 * G3;
		// Work out the hashed gradient indices of the four simplex corners
		const ii = i & 255;
		const jj = j & 255;
		const kk = k & 255;
		// Calculate the contribution from the four corners
		let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
		if (t0 < 0) n0 = 0.0;
		else {
			const gi0 = ii + perm[jj + perm[kk]];
			t0 *= t0;
			n0 = t0 * t0 * (permGrad3x[gi0] * x0 + permGrad3y[gi0] * y0 + permGrad3z[gi0] * z0);
		}
		let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
		if (t1 < 0) n1 = 0.0;
		else {
			const gi1 = ii + i1 + perm[jj + j1 + perm[kk + k1]];
			t1 *= t1;
			n1 = t1 * t1 * (permGrad3x[gi1] * x1 + permGrad3y[gi1] * y1 + permGrad3z[gi1] * z1);
		}
		let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
		if (t2 < 0) n2 = 0.0;
		else {
			const gi2 = ii + i2 + perm[jj + j2 + perm[kk + k2]];
			t2 *= t2;
			n2 = t2 * t2 * (permGrad3x[gi2] * x2 + permGrad3y[gi2] * y2 + permGrad3z[gi2] * z2);
		}
		let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
		if (t3 < 0) n3 = 0.0;
		else {
			const gi3 = ii + 1 + perm[jj + 1 + perm[kk + 1]];
			t3 *= t3;
			n3 = t3 * t3 * (permGrad3x[gi3] * x3 + permGrad3y[gi3] * y3 + permGrad3z[gi3] * z3);
		}
		// Add contributions from each corner to get the final noise value.
		// The result is scaled to stay just inside [-1,1]
		return 32.0 * (n0 + n1 + n2 + n3);
	};
}

let noise = createNoise3D(Math.random);

function shuffle(array, random = Math.random) {
	for (let i = 0; i < array.length; i++) {
		let idx = Math.floor(random() * (array.length - i)) + i;
		[array[i], array[idx]] = [array[idx], array[i]];
	}
	return array;
}
*/

const MAZE_UNLOCK = 1699117200000;
function is_maze(x: Complex, y: Complex): boolean {
	return (
		x.real >= -16 && x.real < 16 &&
		y.real >= -16 && y.real < 16 &&
		x.imag >= -16 && x.imag < 16 &&
		y.imag >= -64 && y.imag < -32
	);
}

function render_block(block: Block, x: Complex, y: Complex): Block {
	if (block.type === "veilstone") {
		return {
			type: "veilstone",
			timeout: Math.floor((MAZE_UNLOCK - Date.now()) / 1000).toString()
		};
	} else if (block.type === "compass") {
		return {
			type: "compass",
			x: x.toString(),
			y: y.toString()
		};
	}
	return block;
}

const CHUNK_SIZE = 8;

class Chunk {
	cx: number;
	cy: number;
	cz: number;
	cw: number;
	
	modified: boolean = false;
	last_interaction: number = Date.now();
	
	data: Block[];
	
	constructor(cx: number, cy: number, cz: number, cw: number, data: Block[] | null) {
		this.cx = cx;
		this.cy = cy;
		this.cz = cz;
		this.cw = cw;
		
		if (
			cx >= -2 && cx < 2 &&
			cy >= -2 && cy < 2 &&
			cz >= -8 && cz < -4 &&
			cw >= -2 && cw < 2
		) {
			this.data = [];
			if (Date.now() < MAZE_UNLOCK) {
				let block: BlockVeilstone = {
					type: "veilstone",
					timeout: "0"
				};
				for (let w = 0; w < CHUNK_SIZE; w++) {
				for (let z = 0; z < CHUNK_SIZE; z++) {
				for (let y = 0; y < CHUNK_SIZE; y++) {
				for (let x = 0; x < CHUNK_SIZE; x++) {
					this.data.push(block);
				}
				}
				}
				}
			} else {
				let ch = MAZE[[cx + 2, cy + 2, cz + 8, cw + 2].join(",")];
				
				for (let w = 0; w < CHUNK_SIZE; w++) {
				for (let z = 0; z < CHUNK_SIZE; z++) {
				for (let y = 0; y < CHUNK_SIZE; y++) {
				for (let x = 0; x < CHUNK_SIZE; x++) {
					let b = ch[w][z][y][x];
					if (b === " ") this.data.push({type: "air"});
					if (b === "#") this.data.push({type: "hypercube"});
					if (b === "G") this.data.push({type: "goal"});
				}
				}
				}
				}
			}
			return;
		}
		
		if (data) {
			this.data = data;
			return;
		}
		
		let preset: number[][][][];
		
		let seed = mod(cx + cy * 100 + cz * 100 * 100 + cw * 100 * 100 * 100, 2**16);
		function rand() {
			seed = (seed ** 2) % 2**16;
			return seed / 2**16;
		}
		
		let depth = -cz;
		
		let is_stair = rand() < Math.max(8 - depth, 0) / 8 * 0.5;
		
		let layer = Math.floor((depth + 1) / 2);
		let rock_str = new Complex(layer ** 2, Math.max(layer - 12, 0));
		
		if (cz === 0) {
			// Ground
			let r = rand();
			if (r < 0.05) {
				preset = BUILDING;
			} else if (r < 0.3) {
				preset = TREE;
			} else {
				preset = BLANK_FLOOR;
			}
		} else if (cz > 0) {
			// Air
			if (cz < 16) {
				preset = AIR;
			} else if (rand() < 0.1) {
				preset = CLOUD;
			} else {
				preset = AIR;
			}
		} else {
			if (depth % 2 === 1) {
				let below_seed = mod(cx + cy * 100 + (cz - 1) * 100 * 100 + cw * 100 * 100 * 100, 2**16);
				function below_rand() {
					below_seed = (below_seed ** 2) % 2**16;
					return below_seed / 2**16;
				}
				let is_stair = below_rand() < Math.max(8 - depth, 0) / 8 * 0.5;
				
				preset = is_stair ? ROCK_STAIRS : ROCKS;
			} else {
				if (mod(cx, 2) === 1) {
					if (mod(cy, 2) === 1) {
						preset = ROCKS;
					} else {
						preset = mod(cw, 2) === 0 ? CORRIDOR_X : ROCKS;
					}
				} else if (mod(cy, 2) === 1) {
					if (mod(cx, 2) === 1) {
						preset = ROCKS;
					} else {
						preset = mod(cw, 2) === 0 ? CORRIDOR_Y : ROCKS;
					}
				} else {
					if (mod(cw, 2) === 1) {
						preset = CORRIDOR_W;
					} else if (mod(cx + cy + cw, 4) === 0) {
						preset = is_stair ? STAIRS : EMPTY_ROOM;
					} else {
						preset = JUNCTION;
					}
				}
			}
		}
		
		this.data = [];
		for (let w = 0; w < CHUNK_SIZE; w++) {
		for (let z = 0; z < CHUNK_SIZE; z++) {
		for (let y = 0; y < CHUNK_SIZE; y++) {
		for (let x = 0; x < CHUNK_SIZE; x++) {
			let b = PALETTE[preset[w][z][y][x]];
			if (b.type === "rock") {
				b.strength = rock_str.toString();
			}
			this.data.push(b);
		}
		}
		}
		}
	}
	
	static getKey(x: number, y: number, z: number, w: number): number {
		return x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE + w * CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
	}
	
	getBlock(x: number, y: number, z: number, w: number): Block {
		this.last_interaction = Date.now();
		return this.data[Chunk.getKey(x, y, z, w)];
	}
	
	setBlock(x: number, y: number, z: number, w: number, block: Block) {
		this.modified = true;
		this.last_interaction = Date.now();
		this.data[Chunk.getKey(x, y, z, w)] = block;
	}
	
	toJson(): Block[] {
		return this.data;
	}
	
	save(): Promise<void> {
		return new Promise(resolve => {
			if (!this.modified) return resolve();
			this.modified = false;
			
			let filename = MAP_PATH + `${this.cx},${this.cy},${this.cz},${this.cw}`;
			fs.writeFile(filename, JSON.stringify(this.toJson()), () => resolve());
		});
	}
}

let no_maze = Date.now() < MAZE_UNLOCK;

class Map {
	chunks: Record<string, Chunk> = {};
	entities: Set<Entity> = new Set();
	records: Record<string, number> = {};
	
	constructor() {
		this.load();
	}
	
	getChunk(x: number, y: number, z: number, w: number): Chunk {
		let key = `${x},${y},${z},${w}`;
		if (key in this.chunks) return this.chunks[key];
		
		if (fs.existsSync(MAP_PATH + key)) {
			let data = JSON.parse(fs.readFileSync(MAP_PATH + key).toString());
			let chunk = new Chunk(x, y, z, w, data);
			this.chunks[key] = chunk;
			return chunk;
		} else {
			let chunk = new Chunk(x, y, z, w, null);
			this.chunks[key] = chunk;
			return chunk;
		}
	}
	
	getBlock(x: number, y: number, z: number, w: number): Block {
		let chunk = this.getChunk(
			Math.floor(x / CHUNK_SIZE),
			Math.floor(y / CHUNK_SIZE),
			Math.floor(z / CHUNK_SIZE),
			Math.floor(w / CHUNK_SIZE)
		);
		
		return chunk.getBlock(
			mod(x, CHUNK_SIZE),
			mod(y, CHUNK_SIZE),
			mod(z, CHUNK_SIZE),
			mod(w, CHUNK_SIZE)
		);
	}
	
	setBlock(x: number, y: number, z: number, w: number, block: Block) {
		let chunk = this.getChunk(
			Math.floor(x / CHUNK_SIZE),
			Math.floor(y / CHUNK_SIZE),
			Math.floor(z / CHUNK_SIZE),
			Math.floor(w / CHUNK_SIZE)
		);
		
		chunk.setBlock(
			mod(x, CHUNK_SIZE),
			mod(y, CHUNK_SIZE),
			mod(z, CHUNK_SIZE),
			mod(w, CHUNK_SIZE),
			block
		);
	}
	
	addEntity(entity: Entity) {
		this.entities.add(entity);
	}
	
	removeEntity(entity: Entity) {
		this.entities.delete(entity);
	}
	
	getEntities(x: number, y: number, z: number, w: number): Entity[] {
		let out: Entity[] = [];
		for (let entity of this.entities) {
			let [ex, ey, ez, ew] = c2d_to_4d(entity.x, entity.y);
			if (ex !== x || ey !== y || ez !== z) continue;
			
			if (ew === w)
				out.push(entity);
			else if (Math.abs(ew - w) < 4)
				out.push(new Ghost(new Complex(ex, w), new Complex(ey, ez), entity));
		}
		return out;
	}
	
	getSurroundings(x: number, y: number, z: number, w: number): {map: Block[][], entities: JsonEntity[]} {
		let map: Block[][] = [];
		let entities: Entity[] = [];
		for (let dy = -7; dy <= 7; dy++) {
			let row: Block[] = [];
			for (let dx = -7; dx <= 7; dx++) {
				let block = render_block(this.getBlock(x + dx, y + dy, z, w), new Complex(x, w), new Complex(y, z));
				
				row.push(block);
				entities.push(...this.getEntities(x + dx, y + dy, z, w));
			}
			map.push(row);
		}
		return {
			map,
			entities: entities.map(e => e.toJson(new Complex(x, w), new Complex(y, z)))
		};
	}
	
	tick(tick: number) {
		if (no_maze && Date.now() >= MAZE_UNLOCK) {
			no_maze = false;
			
			for (let cx = -2; cx < 2; cx++) {
				for (let cy = -2; cy < 2; cy++) {
					for (let cz = -8; cz < -4; cz++) {
						for (let cw = -2; cw < 2; cw++) {
							let key = `${cx},${cy},${cz},${cw}`;
							delete this.chunks[key];
						}
					}
				}
			}
		}
		
		for (let entity of this.entities) {
			entity.tick(tick);
		}
	}
	
	async save() {
		let startTime = Date.now();
		
		await Promise.all(Object.values(this.chunks).map(chunk => chunk.save()));
		
		for (let [key, chunk] of Object.entries(this.chunks)) {
			if (Date.now() - chunk.last_interaction <= CHUNK_CACHE_TIME) continue;
			
			delete this.chunks[key];
		}
		
		let data = {
			entities: Array.from(this.entities).filter(e => !(e instanceof Player)).map(e => e.toJson(new Complex(0), new Complex(0))),
			records: this.records
		};
		fs.writeFile(MAP_PATH + "map.json", JSON.stringify(data), () => {
			let dt = Date.now() - startTime;
			if (dt > 100)
				logger.log("Wrote map in " + dt + "ms");
		});
	}
	
	load() {
		let data = JSON.parse(fs.readFileSync(MAP_PATH + "map.json").toString());
		this.records = data.records;
		
		for (let entity of data.entities) {
			this.entities.add(Entity.fromJson(entity));
		}
	}
}

abstract class Entity extends EventEmitter {
	x: Complex;
	y: Complex;
	
	hp: Complex = new Complex(8);
	
	inventory: Record<string, Slot> = {};
	
	// Calculated
	max_hp: Complex = new Complex(8);
	defense: Complex = new Complex(0);
	range: number = 1;
	has_spider_legs: boolean = false;
	
	constructor(x: Complex, y: Complex) {
		super();
		this.x = x;
		this.y = y;
	}
	
	dist(other: Entity) {
		return this.x.manhattan(other.x) + this.y.manhattan(other.y);
	}
	closest(filter: (e: Entity) => boolean): Entity | null {
		let closest: Entity | null = null;
		let closest_dist = Infinity;
		for (let entity of map.entities) {
			if (!filter(entity)) continue;
			let dist = this.dist(entity);
			if (dist >= closest_dist) continue;
			closest = entity;
			closest_dist = dist;
		}
		return closest;
	}
	
	hit(other: Entity, slot: Slot | null): boolean {
		if (slot && slot.item.type === "health_potion") {
			this.hp = Complex.min(this.hp.plus(this.max_hp.times(new Complex(0.20, 0.20)).floor()), this.max_hp);
			return true;
		}
		
		const calc_dmg = (damage: Complex) => {
			let def_real = damage.real > 0 ? Math.min(this.defense.real, damage.real) : 0;
			let def_imag = damage.imag > 0 ? Math.min(this.defense.imag, damage.imag) : 0;
			damage = new Complex(damage.real - def_real, damage.imag - def_imag);
			if (other instanceof Monster) {
				if (damage.real > 0 && this.hp.real > 0) damage.real = Math.min(damage.real, this.hp.real);
				if (damage.real < 0 && this.hp.real < 0) damage.real = Math.max(damage.real, this.hp.real);
				if (damage.imag > 0 && this.hp.imag > 0) damage.imag = Math.min(damage.imag, this.hp.imag);
				if (damage.imag < 0 && this.hp.imag < 0) damage.imag = Math.max(damage.imag, this.hp.imag);
			}
			return this.hp.minus(damage);
		};
		
		let damage = new Complex(1);
		if (slot && slot.item.type === "sword") {
			damage = Complex.parse(slot.item.strength)!;
		} else if (other instanceof Monster) {
			let swords = Object.values(other.inventory).map(slot => slot.item).filter(item => item.type === "sword");
			let best = Infinity;
			for (let sword of swords as BlockSword[]) {
				let dmg = Complex.parse(sword.strength)!;
				let new_best = calc_dmg(dmg).manhattan(new Complex(0));
				if (new_best < best) {
					best = new_best;
					damage = dmg;
				}
			}
		}
		this.hp = calc_dmg(damage);
		if (this.hp.is_zero()) {
			this.die(other);
		}
		return false;
	}
	
	die(killer: Entity) {
		if (killer instanceof Player) {
			killer.killed(this);
		}
	}
	
	getItem(slot: Complex): Slot | null {
		if (slot.toString() in this.inventory) {
			return this.inventory[slot.toString()];
		} else {
			return null;
		}
	}
	
	addItem(item: Block, slot: Complex, count: Complex = new Complex(1)): boolean {
		let existing = this.getItem(slot);
		if (!existing) {
			this.inventory[slot.toString()] = new Slot(item, count);
			return true;
		} else if (block_eq(item, existing.item)) {
			existing.count = existing.count.plus(count);
			return true;
		} else {
			return false;
		}
	}
	
	removeItem(item: Block, slot: Complex, count: Complex = new Complex(1)): boolean {
		let existing = this.getItem(slot);
		if (!existing) return false;
		
		if (!block_eq(item, existing.item)) return false;
		
		existing.count = existing.count.minus(count);
		if (existing.count.is_zero()) {
			delete this.inventory[slot.toString()];
		}
		return true;
	}
	
	tick(tick: number) {
		this.max_hp = new Complex(8);
		let hp_regen = new Complex(0);
		this.defense = new Complex(0);
		this.range = 1;
		
		for (let [key, value] of Object.entries(this.inventory)) {
			if (value.item.type !== "soul") continue;
			
			let visited: Record<string, boolean> = {};
			const visit = (pos: Complex, multiplier: Complex) => {
				let key = pos.toString();
				if (!(key in this.inventory)) return;
				if (key in visited) return;
				visited[key] = true;
				
				let slot = this.inventory[key];
				if (slot.item.type === "artery" || slot.item.type === "soul") {
					visit(pos.plus(new Complex(1, 0)), multiplier);
					visit(pos.plus(new Complex(-1, 0)), multiplier);
					visit(pos.plus(new Complex(0, 1)), multiplier);
					visit(pos.plus(new Complex(0, -1)), multiplier);
				} else if (slot.item.type === "ventricle") {
					this.max_hp = this.max_hp.plus(new Complex(slot.count.real * multiplier.real, 0));
				} else if (slot.item.type === "ventrcle") {
					this.max_hp = this.max_hp.plus(new Complex(0, slot.count.real * multiplier.real));
				} else if (slot.item.type === "bone_marrow") {
					hp_regen = hp_regen.plus(new Complex(slot.count.real * multiplier.real, slot.count.real * multiplier.real));
				} else if (slot.item.type === "shield") {
					this.defense = this.defense.plus(new Complex(slot.count.real * multiplier.real, 0));
				} else if (slot.item.type === "sheld") {
					this.defense = this.defense.plus(new Complex(0, slot.count.real * multiplier.real));
				} else if (slot.item.type === "multiplier") {
					let new_multiplier = multiplier.plus(new Complex(0.1, 0.1).times(new Complex(slot.count.real, slot.count.real)));
					visit(pos.plus(new Complex(1, 0)), new_multiplier);
					visit(pos.plus(new Complex(-1, 0)), new_multiplier);
					visit(pos.plus(new Complex(0, 1)), new_multiplier);
					visit(pos.plus(new Complex(0, -1)), new_multiplier);
				} else if (slot.item.type === "telekinetic_orb") {
					this.range += slot.count.real;
				}
			};
			visit(Complex.parse(key)!, new Complex(1, 1));
		}
		
		if (tick % 8 === 0) {
			this.hp = this.hp.plus(hp_regen);
		}
		
		this.max_hp = this.max_hp.floor();
		this.hp = Complex.min(this.hp.floor(), this.max_hp);
		this.defense = this.defense.floor();
		
		this.has_spider_legs = Object.values(this.inventory).some(slot => slot.item.type === "spider_legs");
		
		let floor = map.getBlock(this.x.real, this.y.real, this.y.imag - 1, this.x.imag);
		if (floor.type === "air") {
			if (!this.has_spider_legs) {
				this.y = this.y.minus(new Complex(0, 1));
			} else {
				let left = map.getBlock(this.x.real - 1, this.y.real, this.y.imag, this.x.imag).type === "air";
				let right = map.getBlock(this.x.real + 1, this.y.real, this.y.imag, this.x.imag).type === "air";
				let front = map.getBlock(this.x.real, this.y.real - 1, this.y.imag, this.x.imag).type === "air";
				let back = map.getBlock(this.x.real, this.y.real + 1, this.y.imag, this.x.imag).type === "air";
				let up = map.getBlock(this.x.real, this.y.real, this.y.imag + 1, this.x.imag).type === "air";
				let ana = map.getBlock(this.x.real, this.y.real, this.y.imag, this.x.imag - 1).type === "air";
				let kata = map.getBlock(this.x.real, this.y.real, this.y.imag, this.x.imag + 1).type === "air";
				if (left && right && front && back && up && ana && kata) {
					this.y = this.y.minus(new Complex(0, 1));
				}
			}
		}
	}
	static fromJson(data: JsonEntity): Entity {
		if (data.type === "monster") {
			return Monster.fromJson(data);
		} else {
			throw new Error("Invalid entity");
		}
	}
	abstract toJson(x: Complex, y: Complex): JsonEntity;
}

class Ghost extends Entity {
	source: Entity;
	
	constructor(x: Complex, y: Complex, source: Entity) {
		super(x, y);
		
		this.source = source;
	}
	
	toJson(x: Complex, y: Complex): JsonGhost {
		return {
			type: "ghost",
			x: this.x.minus(x).toString(), y: this.y.minus(y).toString()
		};
	}
}

class Player extends Entity {
	name: string;
	xp: Complex = new Complex(16);
	level: Complex = this.xp.sqrt().floor();
	
	constructor(name: string) {
		let x = new Complex(Math.floor(Math.random() * 256) - 128, 3);
		let y = new Complex(Math.floor(Math.random() * 256) - 128, 1);
		//let x = new Complex(0, 3);
		//let y = new Complex(0, 1);
		
		super(x, y);
		
		this.name = name;
	}
	
	respawn() {
		this.x = new Complex(Math.floor(Math.random() * 256) - 128, 3);
		this.y = new Complex(Math.floor(Math.random() * 256) - 128, 1);
		this.hp = new Complex(8);
		this.max_hp = new Complex(8);
		this.inventory = {};
	}
	
	die(killer: Entity) {
		if (map.getBlock(...c2d_to_4d(this.x, this.y)).type === "air" && !is_maze(this.x, this.y)) {
			map.setBlock(...c2d_to_4d(this.x, this.y), {type: "tombstone", text: `R.I.P. ${this.name}`});
		}
		
		this.xp = this.xp.minus(new Complex(1));
		this.level = this.xp.sqrt().floor();
		this.respawn();
		super.die(killer);
	}
	
	killed(entity: Entity) {
		this.xp = this.xp.plus(new Complex(1));
		this.level = this.xp.sqrt().floor();
	}
	
	tick(tick: number) {
		super.tick(tick);
		
		if (tick % 20 === 0) {
			if (this.hp.real < this.max_hp.real) {
				this.hp = this.hp.plus(new Complex(1));
			}
			
			let closest = this.closest(e => e instanceof Monster);
			if (closest && this.dist(closest) < 16) return;
			
			for (let i = 0; i < 8; i++) {
				let dx = Math.floor((Math.random() - 0.5) * 16);
				let dy = Math.floor((Math.random() - 0.5) * 16);
				let dw = Math.floor((Math.random() - 0.5) * 16);
				
				let spawn_x = this.x.plus(new Complex(dx, dw));
				let spawn_y = this.y.plus(new Complex(dy));
				
				if (map.getBlock(...c2d_to_4d(spawn_x, spawn_y)).type === "air" && !is_maze(spawn_x, spawn_y)) {
					map.addEntity(new Monster(spawn_x, spawn_y));
					break;
				}
			}
		}
	}
	
	toJson(x: Complex, y: Complex): JsonPlayer {
		let inventory = Object.fromEntries(Object.entries(this.inventory).map(([key, slot]) => {
			let item: Item = Object.assign({count: slot.count.toString()}, render_block(slot.item, this.x, this.y));
			return [key, item];
		}));
		return {
			type: "player",
			x: this.x.minus(x).toString(), y: this.y.minus(y).toString(),
			name: this.name,
			xp: this.xp.toString(), level: this.level.toString(),
			hp: this.hp.toString(), max_hp: this.max_hp.toString(),
			inventory
		};
	}
}

class Monster extends Entity {
	constructor(x: Complex, y: Complex) {
		super(x, y);
		
		let depth = Math.floor(-y.imag / 32);
		
		if (depth < 0) return;
		if (depth === 0) {
			this.addItem({type: "soul"}, new Complex(1));
			let max_hp = Math.floor(Math.random() * 6);
			if (max_hp)
				this.addItem({type: "ventricle"}, new Complex(0), new Complex(max_hp));
			if (Math.random() < 0.1)
				this.addItem({type: "ventricle"}, new Complex(2));
		} else if (depth < 8) {
			let branches = Math.floor(Math.random() * depth);
			
			let soul_pos = new Complex(Math.floor(Math.random() * 10 - 5), Math.floor(Math.random() * 10 - 5));
			const branch = (pos: Complex) => {
				if (branches === 0) return;
				let bs = Math.min(Math.floor(Math.random() * 3) + 1, branches);
				branches -= bs;
				
				let dirs = [new Complex(-1, 0), new Complex(1, 0), new Complex(0, -1), new Complex(0, 1)];
				shuffle(dirs);
				for (let i = 0; i < bs; i++) {
					let len = Math.floor(Math.random() * 4) + 1;
					let new_pos = pos.plus(dirs[i]);
					for (let j = 0; j < len; j++) {
						this.addItem({type: "artery"}, new_pos);
						new_pos = new_pos.plus(dirs[i]);
					}
					if (branches !== 0 && Math.random() < 0.5) {
						this.addItem({type: "artery"}, new_pos);
						branch(new_pos);
					} else {
						const items: Block[] = [{type: "ventricle"}, {type: "bone_marrow"}, {type: "shield"}];
						let item = items[Math.floor(Math.random() * items.length)];
						this.addItem(item, new_pos, new Complex(Math.floor(Math.random() * 2) + 1));
					}
				}
			};
			this.addItem({type: "soul"}, soul_pos);
			branch(soul_pos);
			
			let potions = Math.floor(Math.random() * 4);
			for (let i = 0; i < potions; i++) {
				this.addItem({type: "health_potion"}, new Complex(Math.floor(Math.random() * 16 - 8), Math.floor(Math.random() * 16 - 8)));
			}
			
			if (Math.random() < 0.3) {
				let strength = new Complex(Math.floor(Math.random() * 2 * depth - depth), Math.floor(Math.random() * 2 * depth - depth)).toString();
				this.addItem({type: "pickaxe", strength}, new Complex(Math.floor(Math.random() * 16 - 8), Math.floor(Math.random() * 16 - 8)));
			}
			
			let sword_strength = new Complex(Math.floor(Math.random() * depth) + 2).toString()
			this.addItem({type: "sword", strength: sword_strength}, new Complex(Math.floor(Math.random() * 16 - 8), Math.floor(Math.random() * 16 - 8)));
		} else {
			let branches = Math.floor(Math.random() * 12) + 4;
			
			let soul_pos = new Complex(Math.floor(Math.random() * 10 - 5), Math.floor(Math.random() * 10 - 5));
			const branch = (pos: Complex) => {
				if (branches === 0) return;
				let bs = Math.min(Math.floor(Math.random() * 3) + 1, branches);
				branches -= bs;
				
				let dirs = [new Complex(-1, 0), new Complex(1, 0), new Complex(0, -1), new Complex(0, 1)];
				shuffle(dirs);
				for (let i = 0; i < bs; i++) {
					let len = Math.floor(Math.random() * 4) + 1;
					let new_pos = pos.plus(dirs[i]);
					for (let j = 0; j < len; j++) {
						this.addItem({type: "artery"}, new_pos);
						new_pos = new_pos.plus(dirs[i]);
					}
					if (branches !== 0 && Math.random() < 0.5) {
						if (Math.random() < 0.5) {
							this.addItem({type: "artery"}, new_pos);
						} else {
							this.addItem({type: "multiplier"}, new_pos, new Complex(Math.floor(Math.random() * depth) + 1));
						}
						branch(new_pos);
					} else {
						const items: Block[] = [{type: "ventricle"}, {type: "ventrcle"}, {type: "bone_marrow"}, {type: "shield"}, {type: "sheld"}];
						let item = items[Math.floor(Math.random() * items.length)];
						this.addItem(item, new_pos, new Complex(Math.floor(Math.random() * depth) + 1));
					}
				}
			};
			this.addItem({type: "soul"}, soul_pos);
			branch(soul_pos);
			
			let potions = Math.floor(Math.random() * 4);
			for (let i = 0; i < potions; i++) {
				this.addItem({type: "health_potion"}, new Complex(Math.floor(Math.random() * 16 - 8), Math.floor(Math.random() * 16 - 8)));
			}
			
			if (Math.random() < 0.3) {
				let strength = new Complex(Math.floor(Math.random() * 2 * depth - depth), Math.floor(Math.random() * 2 * depth - depth)).toString();
				this.addItem({type: "pickaxe", strength}, new Complex(Math.floor(Math.random() * 16 - 8), Math.floor(Math.random() * 16 - 8)));
			}
			
			if (Math.random() < 0.05) {
				this.addItem({
					type: "compass", x: "0", y: "0"
				}, new Complex(Math.floor(Math.random() * 32 - 16), Math.floor(Math.random() * 32 - 16)));
			}
			
			if (Math.random() < 0.05) {
				this.addItem({
					type: "spider_legs"
				}, new Complex(Math.floor(Math.random() * 32 - 16), Math.floor(Math.random() * 32 - 16)));
			}
			
			this.addItem({
				type: "sword",
				strength: new Complex(Math.floor(Math.random() * depth * 4) + 2, Math.floor(Math.random() * depth * 4) + 2).toString()
			}, new Complex(Math.floor(Math.random() * 32 - 16), Math.floor(Math.random() * 32 - 16)));
			this.addItem({
				type: "sword",
				strength: new Complex(-Math.floor(Math.random() * depth * 4) - 2, -Math.floor(Math.random() * depth * 4) - 2).toString()
			}, new Complex(Math.floor(Math.random() * 32 - 16), Math.floor(Math.random() * 32 - 16)));
			
			let swords = Math.floor(Math.random() * 2);
			for (let i = 0; i < swords; i++) {
				this.addItem({
					type: "sword",
					strength: new Complex(Math.floor((Math.random() * 2 * depth - depth) * 2) + 2, Math.floor((Math.random() * 2 * depth - depth) * 2) + 2).toString()
				}, new Complex(Math.floor(Math.random() * 32 - 16), Math.floor(Math.random() * 32 - 16)));
			}
		}
	}
	
	die(killer: Entity) {
		super.die(killer);
		
		map.removeEntity(this);
		
		let items = Object.values(this.inventory);
		let queue: [Complex, Complex][] = [[this.x, this.y]];
		while (queue.length) {
			let [x, y] = queue.shift()!;
			
			if (items.length === 0) break;
			if (map.getBlock(...c2d_to_4d(x, y)).type !== "air") continue;
			
			map.setBlock(...c2d_to_4d(x, y), items.pop()!.item);
			
			queue.push([x.plus(new Complex(1, 0)), y.plus(new Complex(0, 0))]);
			queue.push([x.plus(new Complex(-1, 0)), y.plus(new Complex(0, 0))]);
			queue.push([x.plus(new Complex(0, 1)), y.plus(new Complex(0, 0))]);
			queue.push([x.plus(new Complex(0, -1)), y.plus(new Complex(0, 0))]);
			queue.push([x.plus(new Complex(0, 0)), y.plus(new Complex(1, 0))]);
			queue.push([x.plus(new Complex(0, 0)), y.plus(new Complex(-1, 0))]);
			queue.push([x.plus(new Complex(0, 0)), y.plus(new Complex(0, 1))]);
			queue.push([x.plus(new Complex(0, 0)), y.plus(new Complex(0, -1))]);
		}
	}
	
	tick(tick: number) {
		super.tick(tick);
		
		if (tick % 4 !== 0) return;
		let closest_player = this.closest(e => e instanceof Player);
		if (closest_player === null || this.dist(closest_player) >= 16) return;
		
		//logger.log("Should move");
		
		let dx = closest_player.x.minus(this.x).sign();
		let dy = closest_player.y.minus(this.y).sign();
		
		this.move(dx, dy);
	}
	
	move(x: Complex, y: Complex) {
		let new_x = this.x.plus(x);
		let new_y = this.y.plus(y);
		
		if (is_maze(new_x, new_y)) return;
		
		let block = map.getBlock(...c2d_to_4d(new_x, new_y));
		if (block.type !== "air") return;
		
		let entities = map.getEntities(...c2d_to_4d(new_x, new_y));
		if (entities.length === 0) {
			this.x = new_x;
			this.y = new_y;
		} else {
			for (let e of entities) {
				e.hit(this, null);
			}
		}
	}
	
	static fromJson(data: JsonMonster): Monster {
		let monster = new Monster(Complex.parse(data.x)!, Complex.parse(data.y)!);
		monster.hp = Complex.parse(data.hp)!;
		monster.max_hp = Complex.parse(data.max_hp)!;
		// TODO
		//monster.inventory = data.inventory.map(([item, count]) => [item, Complex.parse(count)!]);
		monster.inventory = Object.fromEntries(Object.entries(data.inventory).map(([key, item]) => {
			let block: Block & {count?: string} = Object.assign({}, item);
			let count = block.count!;
			delete block.count;
			return [key, new Slot(block, Complex.parse(count)!)];
		}));
		return monster;
	}
	toJson(x: Complex, y: Complex): JsonMonster {
		let inventory = Object.fromEntries(Object.entries(this.inventory).map(([key, slot]) => {
			let item: Item = Object.assign({count: slot.count.toString()}, render_block(slot.item, this.x, this.y));
			return [key, item];
		}));
		return {
			type: "monster",
			x: this.x.minus(x).toString(), y: this.y.minus(y).toString(),
			hp: this.hp.toString(), max_hp: this.max_hp.toString(),
			inventory
		};
	}
}

class Connection extends EventEmitter {
	socket: ws;
	player: Player | null = null;
	has_moved: boolean = false;
	
	last_tick: string = "";
	
	achievement_enlightened: boolean = false;
	
	constructor(socket: ws) {
		super();
		this.socket = socket;
		
		this.socket.send(JSON.stringify({type: "connect", version: 1}));
		
		this.socket.addEventListener("message", event => {
			if (typeof event.data !== "string") return;
			
			let data;
			try {
				data = JSON.parse(event.data);
			} catch(e) {
				return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
			}
			
			if (this.player === null) {
				if (data.type !== "connect")
					return socket.send(JSON.stringify({type: "error", message: "Expected \"connect\" packet"}));
				
				if (typeof data.name !== "string")
					return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
				
				logger.log(`Player ${data.name} connected`);
				this.player = new Player(data.name);
				map.addEntity(this.player);
				return;
			}
			
			switch (data.type) {
				case "move": {
					if (typeof data.x !== "string" || typeof data.y !== "string")
						return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
					
					let x = Complex.parse(data.x);
					let y = Complex.parse(data.y);
					
					if (x === null || y === null)
						return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
					
					let new_x = this.player.x.plus(x);
					let new_y = this.player.y.plus(y);
					
					if (!this.has_moved && Math.abs(x.real) <= 1 && Math.abs(x.imag) <= 1 && Math.abs(y.real) <= 1 && Math.abs(y.imag) <= 1) {
						let block = map.getBlock(...c2d_to_4d(new_x, new_y));
						if (block.type === "air" || block.type === "goal") {
							this.player.x = new_x;
							this.player.y = new_y;
							this.has_moved = true;
							
							if (block.type === "goal")
								console.log(`Goal reached - ${this.player.name} - (${new_x.toString()}, ${new_y.toString()})`);
							
							if (!(this.player.name in map.records)) map.records[this.player.name] = 0;
							map.records[this.player.name] = Math.min(map.records[this.player.name], new_y.imag);
							
							if ((x.imag !== 0 || y.imag !== 0) && !this.achievement_enlightened) {
								logger.log(`${this.player.name} is enlightened`);
								this.achievement_enlightened = true;
							}
						}
					}
					
					return socket.send(JSON.stringify({type: "move", ...map.getSurroundings(...c2d_to_4d(new_x, new_y))}));
					
					break;
				}
				case "interact": {
					if (typeof data.x !== "string" || typeof data.y !== "string" || typeof data.slot !== "string")
						return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
					
					let x = Complex.parse(data.x);
					let y = Complex.parse(data.y);
					let slot = Complex.parse(data.slot);
					
					if (x === null || y === null || slot === null)
						return socket.send(JSON.stringify({type: "error", message: "Malformed packet"}));
					
					let new_x = this.player.x.plus(x);
					let new_y = this.player.y.plus(y);
					
					// Maze
					if (is_maze(new_x, new_y)) return;
					
					let item = this.player.getItem(slot);
					
					let range = this.player.range;
					if (Math.abs(x.real) <= range && Math.abs(x.imag) <= range && Math.abs(y.real) <= range && Math.abs(y.imag) <= range) {
						let entities = map.getEntities(...c2d_to_4d(new_x, new_y));
						if (entities.length !== 0) {
							for (let entity of entities) {
								let consumed = entity.hit(this.player, item);
								if (!consumed) continue;
								this.player.removeItem(item!.item, slot, new Complex(1));
								break;
							}
						} else {
							let block = map.getBlock(...c2d_to_4d(new_x, new_y));
							if (block.type === "rock") {
								let dmg = new Complex(1);
								if (item && item.item.type === "pickaxe") {
									dmg = Complex.parse(item.item.strength)!;
								}
								let str = Complex.parse(block.strength)!;
								str = str.minus(dmg);
								if (str.is_zero()) {
									map.setBlock(...c2d_to_4d(new_x, new_y), {type: "air"});
								} else {
									map.setBlock(...c2d_to_4d(new_x, new_y), {type: "rock", strength: str.toString()});
								}
							} else if (item === null) {
								// Bare hand. Break
								let block = map.getBlock(...c2d_to_4d(new_x, new_y));
								if (!this.player.addItem(block, slot))
									throw new Error();
								map.setBlock(...c2d_to_4d(new_x, new_y), {type: "air"});
							} else if (block.type === "air") {
								this.player.removeItem(item.item, slot);
								map.setBlock(...c2d_to_4d(new_x, new_y), item.item);
							} else if (block_eq(block, item.item)) {
								if (!this.player.addItem(block, slot))
									throw new Error();
								map.setBlock(...c2d_to_4d(new_x, new_y), {type: "air"});
							}
						}
					}
					
					break;
				}
				default: {
					return socket.send(JSON.stringify({type: "error", message: "Unrecognized packet type"}));
				}
			}
		});
		this.socket.addEventListener("close", () => {
			this.emit("close");
		});
	}
	
	tick(tick: number) {
		if (!this.player) return;
		this.has_moved = false;
		
		let tick_data = JSON.stringify({type: "tick", ...map.getSurroundings(...c2d_to_4d(this.player.x, this.player.y))});
		if (tick_data === this.last_tick) return;
		
		this.last_tick = tick_data;
		this.socket.send(tick_data);
	}
	
	close() {
		if (this.player)
			map.removeEntity(this.player);
	}
}

let connections: Set<Connection> = new Set();
let map = new Map();
let tick = 0;

setInterval(() => {
	map.save();
}, 10 * 1000);

setInterval(() => {
	map.tick(tick);
	for (let connection of connections) {
		connection.tick(tick);
	}
	tick++;
}, 1000 / 4);

server.on("connection", (socket, request) => {
	logger.log(`Connection from ${request.socket.remoteAddress} - ${connections.size + 1} connections total`);
	
	(socket as any).isAlive = true;
	socket.on("pong", () => {
		(socket as any).isAlive = true;
	});
	
	let connection = new Connection(socket);
	connections.add(connection);
	connection.addListener("close", () => {
		if (connection.player)
			logger.log(`Player ${connection.player.name} disconnected`);
		logger.log(`Closed connection from ${request.socket.remoteAddress} - ${connections.size - 1} connections total`);
		connection.close();
		connections.delete(connection);
	});
});

// Heartbeat, detect broken connections
setInterval(() => {
	server.clients.forEach(function each(socket) {
		if ((socket as any).isAlive === false) return socket.terminate();
		if (socket.readyState !== ws.OPEN) return;

		(socket as any).isAlive = false;
		socket.ping();
	});
}, 30000);

httpsServer.on("upgrade", (request, socket, head) => {
	request.headers["access-control-allow-origin"] = "*";
	
	server.handleUpgrade(request, socket, head, ws => {
		server.emit("connection", ws, request);
	});
});

httpsServer.listen(666, () => {
	logger.log("Server started");
});