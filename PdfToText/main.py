from pypdf import PdfReader
import sys

pdf_file_path = sys.argv[1]
result_file_path = sys.argv[2]

reader = PdfReader(pdf_file_path)
number_of_pages = len(reader.pages)

combined = ""

for page in reader.pages:
	text = page.extract_text()
	combined = combined + " " + text

with open(result_file_path, "w") as text_file:
    text_file.write(combined)

print("Success!")
