// Invoked like: cargo run https://worldgravywrestling.com result.pdf

use std::error::Error;
use std::{env, fs};

use anyhow::Result;

use headless_chrome::Browser;
use headless_chrome::protocol::cdp::Page;

fn browse_wikipedia() -> Result<(), Box<dyn Error>> {
    let url = env::args().nth(1).expect("Must provide url");
    let destination = env::args().nth(2).expect("Must provide destination");
    println!("Asked for URL {:?} to PDF file {:?}", url, destination);

    let browser = Browser::default()?;

    let tab = browser.new_tab()?;

    // Navigate to wikipedia
    tab.navigate_to(&url)?;

    let wikidata = tab
        .wait_until_navigated()?
        .print_to_pdf(None)?;
    fs::write(&destination, wikidata)?;
    println!("PDF {:?} successfully created from {:?}", destination, url);

    Ok(())
}

fn main() {
	browse_wikipedia().expect("Browse failed!");
	println!("Success!");
}
