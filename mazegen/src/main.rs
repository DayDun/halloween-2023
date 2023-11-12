use rand::thread_rng;
use rand::seq::SliceRandom;
use std::io::Write;
use std::fs::File;

const SIZE: usize = 31;

#[derive(Copy, Clone, Eq, PartialEq, Default)]
enum Cell {
	Empty,
	#[default]
	Wall,
	Goal
}

type Grid<T> = [[[[T; SIZE]; SIZE]; SIZE]; SIZE];
type Pos = (usize, usize, usize, usize);

fn solve_maze(maze: &Grid<Cell>) {
	let mut visited = Grid::<bool>::default();
	
	fn trav(visited: &mut Grid<bool>, grid: &Grid<Cell>, pos: Pos) -> Option<Vec<&'static str>> {
		visited[pos.0][pos.1][pos.2][pos.3] = true;
		
		for (dir, name) in [
			((-1,  0,  0,  0), "left"),
			(( 1,  0,  0,  0), "right"),
			(( 0, -1,  0,  0), "up"),
			(( 0,  1,  0,  0), "down"),
			(( 0,  0, -1,  0), "backward"),
			(( 0,  0,  1,  0), "forward"),
			(( 0,  0,  0, -1), "ana"),
			(( 0,  0,  0,  1), "kata")
		] {
			let np = (
				(pos.0 as isize + dir.0) as usize,
				(pos.1 as isize + dir.1) as usize,
				(pos.2 as isize + dir.2) as usize,
				(pos.3 as isize + dir.3) as usize
			);
			
			if
				visited[np.0][np.1][np.2][np.3] ||
				grid[np.0][np.1][np.2][np.3] == Cell::Wall
			{
				continue;
			}
			
			if grid[np.0][np.1][np.2][np.3] == Cell::Goal {
				return Some(vec![name]);
			}
			
			if let Some(path) = trav(visited, grid, np) {
				return Some([name].into_iter().chain(path.into_iter()).collect());
			}
		}
		
		None
	}
	
	if let Some(path) = trav(&mut visited, maze, (1, 1, 1, 1)) {
		println!("{}", path.len());
	} else {
		println!("No solution");
	}
}

fn thread_main() {
	let mut grid = Grid::<Cell>::default();
	
	let mut visited = Grid::<bool>::default();
	
	fn trav(visited: &mut Grid<bool>, grid: &mut Grid<Cell>, pos: Pos) {
		visited[pos.0][pos.1][pos.2][pos.3] = true;
		grid[pos.0][pos.1][pos.2][pos.3] = Cell::Empty;
		
		let mut dirs = [
			(-1,  0,  0,  0),
			( 1,  0,  0,  0),
			( 0, -1,  0,  0),
			( 0,  1,  0,  0),
			( 0,  0, -1,  0),
			( 0,  0,  1,  0),
			( 0,  0,  0, -1),
			( 0,  0,  0,  1)
		];
		dirs.shuffle(&mut thread_rng());
		
		for dir in dirs {
			let np = (
				pos.0 as isize + dir.0 * 2,
				pos.1 as isize + dir.1 * 2,
				pos.2 as isize + dir.2 * 2,
				pos.3 as isize + dir.3 * 2
			);
			
			if
				np.0 < 0 || np.0 >= SIZE as isize ||
				np.1 < 0 || np.1 >= SIZE as isize ||
				np.2 < 0 || np.2 >= SIZE as isize ||
				np.3 < 0 || np.3 >= SIZE as isize
			{
				continue;
			}
			
			let np = (np.0 as usize, np.1 as usize, np.2 as usize, np.3 as usize);
			
			if visited[np.0][np.1][np.2][np.3] {
				continue;
			}
			
			grid
				[(pos.0 as isize + dir.0) as usize]
				[(pos.1 as isize + dir.1) as usize]
				[(pos.2 as isize + dir.2) as usize]
				[(pos.3 as isize + dir.3) as usize] = Cell::Empty;
			trav(visited, grid, np);
		}
	}
	
	trav(&mut visited, &mut grid, (1, 1, 1, 1));
	
	for dx in -1 as isize..1 {
		for dy in -1 as isize..1 {
			for dz in -1 as isize..1 {
				for dw in -1 as isize..1 {
					let np = (
						15 + dx,
						15 + dy,
						15 + dz,
						15 + dw
					);
					
					let dist = [dx.abs(), dy.abs(), dz.abs(), dw.abs()].into_iter().max().unwrap();
					
					grid[np.0 as usize][np.1 as usize][np.2 as usize][np.3 as usize] = match dist {
						0 => Cell::Goal,
						_ => Cell::Empty
					};
				}
			}
		}
	}
	
	println!("Generated maze!");
	
	solve_maze(&grid);
	
	println!("Hello, world!");
	
	let mut out = File::create("maze.json").unwrap();
	out.write_all(b"{\n").unwrap();
	let mut write_chunk = |name: &str, pos: Pos| {
		out.write_all(format!("\t\"{name}\": [\n").as_bytes()).unwrap();
		for w in 0..8 {
			out.write_all(b"\t\t[\n").unwrap();
			for z in 0..8 {
				out.write_all(b"\t\t\t[\n").unwrap();
				for y in 0..8 {
					let mut line = Vec::with_capacity(8);
					for x in 0..8 {
						let cell = grid[pos.0 + x][pos.1 + y][pos.2 + z][pos.3 + w];
						line.push(match cell {
							Cell::Empty => "\" \"",
							Cell::Wall => "\"#\"",
							Cell::Goal => "\"G\""
						});
					}
					out.write_all(format!("\t\t\t\t[{}],\n", line.join(",")).as_bytes()).unwrap();
				}
				out.write_all(b"\t\t\t],\n").unwrap();
			}
			out.write_all(b"\t\t],\n").unwrap();
		}
		out.write_all(b"\t],\n").unwrap();
	};
	for x in 0..4 {
		for y in 0..4 {
			for z in 0..4 {
				for w in 0..4 {
					write_chunk(&format!("{x},{y},{z},{w}"), ([0, 8, 15, 23][x], [0, 8, 15, 23][y], [0, 8, 15, 23][z], [0, 8, 15, 23][w]));
				}
			}
		}
	}
	out.write_all(b"}").unwrap();
}

fn main() {
	let child = std::thread::Builder::new()
		.stack_size(1024 * 1024 * 100)
		.spawn(thread_main)
		.unwrap();

	child.join().unwrap();
}
