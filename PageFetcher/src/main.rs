// Invoked like: cargo run https://worldgravywrestling.com result.pdf

use std::error::Error;
use headless_chrome::util;
use std::fs;
use std::io;
use std::io::BufRead;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::cmp::min;
use std::sync::mpsc::TryRecvError;
use std::sync::Arc;
use headless_chrome::Tab;
use headless_chrome::browser::ConnectionClosed;
use std::thread;
use headless_chrome::LaunchOptions;
use std::time::Duration;
use anyhow::anyhow;
use headless_chrome::browser::default_executable;
use std::time::Instant;

use anyhow::Result;

use headless_chrome::Browser;

const BROWSER_TIMEOUT_SECS: u64 = 30;

fn new_browser() -> Result<Browser, anyhow::Error> {
  return Browser::new(
	  	LaunchOptions::default_builder()
					// .enable_logging(true)
					// .idle_browser_timeout(Duration::from_secs(BROWSER_TIMEOUT_SECS))
	  	    .path(Some(default_executable().map_err(|e| anyhow!(e))?))
	  	    .build()
	  	    .expect("Error building browser options"));
}

fn main() {
  let mut browser = Browser::default().expect("Error creating browser");

  println!("Ready");

  eprintln!("Created chrome instance, waiting for requests.");

  let mut stdin_channel = spawn_stdin_channel();
  let mut requests: Vec<Request> = Vec::new();

  // Initial number of concurrent tabs.
  // Whenever a batch has timeout'd tabs we'll decrease this,
  // and whenever a batch is all successes we'll increase it.
  let mut max_tab_count = 5;

  let mut last_successful_batch_time = Instant::now();

  loop {
  	collect_waiting_requests(&mut stdin_channel, &mut requests);

    let batch_start_time = Instant::now();
    let time_between_batches = batch_start_time.duration_since(last_successful_batch_time);
    if time_between_batches >= Duration::from_secs(BROWSER_TIMEOUT_SECS) {
    	// The socket to chrome only stays alive for thirty seconds, so recreate it
  		eprintln!("It's been a while since last successful batch, so recreating chrome instance...");
    	browser = new_browser().expect("Error recreating browser");
  		eprintln!("Recreated chrome instance.");
    }

    let mut batch_had_timeouts = false;

  	let mut running_reqs_and_tabs = Vec::new();

    let num_requests = min(max_tab_count, requests.len());
  	for req in requests.drain(0..num_requests).collect::<Vec<Request>>() {
      eprintln!("Processing request {} for url {} to file {}", req.uuid, req.url, req.output_path);

		  match start_tab(&mut browser, req.url.to_string()) {
		  	Ok(tab) => {
		  		running_reqs_and_tabs.push((req, tab));
		  	}
		  	Err(err) => {
		  		handle_error_maybe_requeue_a(
		  				&mut requests, &mut batch_had_timeouts, req, "starting tab", err);
		  		continue;
		  	}
		  }
    }

    for (req, tab) in running_reqs_and_tabs.drain(..).collect::<Vec<(Request, Arc<Tab>)>>() {
    	match tab.wait_until_navigated() {
    		Ok(_) => {}
    		Err(err) => {
    			handle_error_maybe_requeue_b(
    					&mut requests, &mut batch_had_timeouts, req, "waiting on tab", &err);
		  		continue;
    		}
    	}
		  let data =
		  		match tab.print_to_pdf(None) {
		    		Ok(d) => d,
		    		Err(err) => {
		    			handle_error_maybe_requeue_b(&mut requests, &mut batch_had_timeouts, req, "pdfing tab", &err);
				  		continue;
		    		}
		  		};
		  match fs::write(&req.output_path, data) {
    		Ok(()) => (),
    		Err(err) => {
    			handle_error_maybe_requeue_a(&mut requests, &mut batch_had_timeouts, req, "writing pdf file", Box::new(err));
		  		continue;
    		}
		  }

		  println!("{} success {} {}", req.uuid, req.url, req.output_path);
		}

  	let batch_end_time = Instant::now();

		if batch_had_timeouts {
			if max_tab_count > 1 {
				eprintln!("Batch had timeouts, reducing throttle to {}", max_tab_count);
				max_tab_count -= 1;
			}
		} else {
			last_successful_batch_time = batch_end_time;
			if num_requests == max_tab_count {
				max_tab_count += 1;
				eprintln!("Maxed batch was successful, increasing throttle to {}", max_tab_count);
			}
		}

    let batch_elapsed = batch_end_time.duration_since(batch_start_time);
    if batch_elapsed < Duration::from_secs(10) {
	    let remaining_time = Duration::from_secs(10) - batch_elapsed;
	    thread::sleep(remaining_time);
	  }
  }
}


fn spawn_stdin_channel() -> Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || loop {
		    let stdin = io::stdin();
		    let handle = stdin.lock();
		    
		    for line in handle.lines() {
		        match line {
		            Ok(line) => {
        					tx.send(line).unwrap();
		            }
		            Err(error) => {
		                if error.kind() == io::ErrorKind::UnexpectedEof {
		                    println!("Stdin closed.");
		                    break;
		                } else {
		                    eprintln!("Error reading stdin: {}", error);
		                    // Handle other errors if needed
		                }
		            }
		        }
		    }

        // let mut buffer = String::new();
        // io::stdin().read_line(&mut buffer).unwrap();
    });
    rx
}

struct Request {
	uuid: String,
	url: String,
	output_path: String,
	try_num: i32
}

fn collect_waiting_requests(stdin_channel: &mut Receiver<String>, requests: &mut Vec<Request>) {
	loop {
    match stdin_channel.try_recv() {
      Ok(untrimmed_line) => {
      	let line = untrimmed_line.trim();
        eprintln!("Received {} len request: {}", line.len(), line);
      	if line.len() == 0 {
      		eprintln!("Encountered empty line, skipping.");
      		continue;
      	}
		  	if let Some((uuid, after_uuid)) = line.split_once(' ') {
	    		if let Some((url, after_url)) = after_uuid.split_once(' ') {
	    			let output_path = after_url;
		        requests.push(Request {
		        	uuid: uuid.to_string(),
		        	url: url.to_string(),
		        	output_path: output_path.to_string(),
		        	try_num: 0
		        });
		      } else {
		        eprintln!("Request string does not contain enough spaces: {}", line);
		      }
		    } else {
	        eprintln!("Request string does not contain enough spaces: {}", line);
		    }
      }
      Err(TryRecvError::Empty) => {
      	// eprintln!("Nothing, breaking");
      	break;
      }
      Err(TryRecvError::Disconnected) => {
      	panic!("Channel disconnected");
      }
    }
  }
}

fn start_tab(browser: &mut Browser, url: String) -> Result<Arc<Tab>, Box<dyn Error>> {
  let tab = browser.new_tab()?;
  tab.set_default_timeout(std::time::Duration::from_secs(60));

  // Navigate to wikipedia
  tab.navigate_to(&url)?;

  return Ok(tab);
}

fn handle_error_maybe_requeue_inner(
		requests: &mut Vec<Request>,
		batch_had_timeouts: &mut bool,
		mut req: Request,
		operation: &str) {
  eprintln!(
  		"Timeout/disconnect while {} on try num {} for request {} url {}",
  		operation, req.try_num, req.uuid, req.url);
	*batch_had_timeouts = true;
  if req.try_num >= 3 {
  	eprintln!("Giving up on request {} {}", req.uuid, req.url);
		println!("{} error Too many timeouts, retries exhausted.", req.uuid);
  } else {
  	req.try_num += 1;
  	eprintln!("Queueing try num {} for request {} url {}", req.try_num, req.uuid, req.url);
  	requests.push(req);
  }
}

fn handle_error_maybe_requeue_a(
		requests: &mut Vec<Request>,
		batch_had_timeouts: &mut bool,
		req: Request,
		operation: &str,
		err: Box<dyn Error>) {
  eprintln!("Error while {} for request {}: {:?}", operation, req.uuid, err);

	// These don't work for some reason...
	// if err.downcast_ref::<Box<util::Timeout>>().is_some() ||
	// 	  err.downcast_ref::<Box<ConnectionClosed>>().is_some() {
	if format!("{:?}", err).contains("Unable to make method calls because underlying connection is closed") ||
			format!("{:?}", err).contains("The event waited for never came") {
  	handle_error_maybe_requeue_inner(requests, batch_had_timeouts, req, operation);
	} else {
		if format!("{:?}", err).contains("Unable to make method calls because underlying connection is closed") {
      panic!("wtf {:?}", err);
		}
		println!("{} error Unknown error while {}, see logs.", req.uuid, operation)
	}
}

fn handle_error_maybe_requeue_b(
		requests: &mut Vec<Request>,
		batch_had_timeouts: &mut bool,
		req: Request,
		operation: &str,
		err: &anyhow::Error) {
  eprintln!("Error while {} for request {}: {:?}", operation, req.uuid, err);

	if err.downcast_ref::<util::Timeout>().is_some() ||
		  err.downcast_ref::<ConnectionClosed>().is_some() {
  	handle_error_maybe_requeue_inner(requests, batch_had_timeouts, req, operation);
	} else {
		// This should be caught by ConnectionClosed
		if format!("{:?}", err).contains("Unable to make method calls because underlying connection is closed") {
			// Check the source of the error
      if let Some(source) = err.source() {
        eprintln!("Underlying cause: {}", source);
      } else {
        eprintln!("No underlying cause found.");
      }
      panic!("wtf {:?}", err);
		}
		println!("{} error Unknown error while {}, see logs.", req.uuid, operation)
	}
}
