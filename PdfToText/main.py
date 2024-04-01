from pypdf import PdfReader
from bs4 import BeautifulSoup
import sys

pdf_file_path = sys.argv[1]
result_file_path = sys.argv[2]

with open(pdf_file_path, 'r') as file:
  html = file.read()
  soup = BeautifulSoup(html, 'html.parser')
  text = soup.get_text()
  with open(result_file_path, "w") as text_file:
    text_file.write(text)
    print("Success!")

# reader = PdfReader(pdf_file_path)
# number_of_pages = len(reader.pages)

# combined = ""

# for page in reader.pages:
# 	text = page.extract_text()
# 	combined = combined + " " + text

# with open(result_file_path, "w") as text_file:
#     text_file.write(combined)

# print("Success!")
