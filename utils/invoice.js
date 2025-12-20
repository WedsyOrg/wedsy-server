const path = require("path");
const PDFDocument = require("pdfkit");

function toProperCase(inputString) {
  if (typeof inputString !== "string" || inputString.length === 0) {
    return inputString;
  }
  const words = inputString.split(" ");
  const properCaseWords = words.map((word) => {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
  const properCaseString = properCaseWords.join(" ");
  return properCaseString;
}
function generateHeader(doc) {
  doc
    .image(path.join(__dirname, "../assets/logo-black.png"), 50, 45, {
      width: 120,
    })
    .font("Helvetica-Bold")
    .fillColor("#444444")
    .fontSize(20)
    .text("Invoice", 200, 45, { align: "right" })
    .fontSize(10)
    .text("(Original for recipient)", 200, 65, { align: "right" })
    .moveDown();
}

function generateFooter(doc) {
  generateHr(doc, doc.page.height - doc.page.margins.bottom - 12);
  doc
    .font("Helvetica")
    .fontSize(8)
    .text(
      "Please note that this invoice is not a demand for payment",
      50,
      doc.page.height - doc.page.margins.bottom - 10,
      { align: "center", width: 500 }
    );
}
function generateCustomerInformation(doc, payment) {
  const isEvent = Boolean(payment?.event?._id);
  const isOrder = Boolean(payment?.order?._id);

  const orderNumber = isEvent
    ? payment?.event?._id?.toString()?.toUpperCase()
    : isOrder
    ? payment?.order?._id?.toString()?.toUpperCase()
    : "";

  const orderDate = isEvent
    ? formatDate(
        payment?.event?.eventDays?.sort((a, b) => new Date(a.date) - new Date(b.date))?.[0]
          ?.date
      )
    : isOrder
    ? formatDate(payment?.order?.createdAt || payment.createdAt)
    : "";

  doc
    .fontSize(10)
    .font("Helvetica")
    .text(`#${payment._id.toString().toUpperCase()}`, 50, 100)
    .text(`Invoice Date: `, 50, 120, { continued: true })
    .font("Helvetica-Bold")
    .text(`${formatDate(payment.createdAt)}`)
    .font("Helvetica-Bold")
    .text(`Billed To`, 50, 160)
    .font("Helvetica")
    .text(`${payment?.user?.name}`, 50, 176)
    .text(`${payment?.user?.email}`, 50, 188)
    .text(`${payment?.user.phone}`, 50, 200)
    .font("Helvetica-Bold")
    .text(`Order Number: `, 50, 250, { continued: true })
    .font("Helvetica")
    .text(`${orderNumber}`)
    .font("Helvetica-Bold")
    .text(`Order Date: `, 50, 265, { continued: true })
    .font("Helvetica")
    .text(`${orderDate}`)
    .font("Helvetica-Bold")
    .text(`Sold by:`, 200, 120, { align: "right" })
    .text(`Wedsy India Pvt Ltd`, 200, 132, { align: "right" })
    .text(`https://wedsy.in`, 200, 144, { align: "right" })
    .font("Helvetica")
    .text(`Gate5, Palace Ground, Bellary Road`, 200, 180, { align: "right" })
    .text(`Bangalore 560006`, 200, 194, { align: "right" })
    .text(`PAN : AADCW0382R`, 200, 208, { align: "right" })
    .text(`GST : 29AADCW0382R1ZL`, 200, 222, { align: "right" })
    .moveDown();
}

function generateInvoiceTable(doc, payment) {
  try {
    let i;
    let invoiceTableTop = 300;
    doc
      .rect(50, invoiceTableTop - 5, 512, 20)
      .fill("#d9d9d9")
      .fillColor("#444444");

    doc.font("Helvetica-Bold");
    generateTableRow(doc, invoiceTableTop, [
      "S no.",
      "Description",
      "Net amt.",
      "Tax rate",
      "Tax type",
      "Tax amt.",
      "Total",
    ]);
    doc.font("Helvetica");

    const isEvent = Boolean(payment?.event?._id);
    const isOrder = Boolean(payment?.order?._id);

    if (isEvent) {
      let eventDays = payment?.event?.eventDays || [];
      let summary = payment?.event?.amount?.summary || [];

      for (i = 0; i < eventDays.length; i++) {
        invoiceTableTop = invoiceTableTop + 20;
        const item = eventDays[i];
        let amount =
          summary.find((j) => j.eventDayId == item._id)?.total?.toString() || "";
        generateTableRow(doc, invoiceTableTop, [
          i + 1,
          item.name,
          amount,
          `0`,
          `0`,
          `0`,
          amount,
        ]);
      }
    } else if (isOrder) {
      const total = payment?.stats?.total || payment?.order?.amount?.total || payment?.amount / 100 || 0;
      invoiceTableTop = invoiceTableTop + 20;
      generateTableRow(doc, invoiceTableTop, [
        1,
        `Order Payment (${payment?.order?.source || "makeup-and-beauty"})`,
        `${total}`,
        `0`,
        `0`,
        `0`,
        `${total}`,
      ]);
    }
    invoiceTableTop = invoiceTableTop + 20;
    doc
      .strokeColor("#aaaaaa")
      .lineWidth(1)
      .rect(50, invoiceTableTop - 5, 512, 20)
      .stroke()
      .text("Sub Total", 60, invoiceTableTop)
      .text(
        `${
          isEvent
            ? payment?.event?.amount?.preTotal
            : payment?.stats?.total || payment?.order?.amount?.total || payment?.amount / 100 || 0
        }`,
        501.6,
        invoiceTableTop,
        {
        width: 60.4,
        align: "center",
        }
      );
    invoiceTableTop = invoiceTableTop + 20;
    doc
      .strokeColor("#aaaaaa")
      .lineWidth(1)
      .rect(50, invoiceTableTop - 5, 512, 20)
      .stroke()
      .text("Coupon Discount", 60, invoiceTableTop)
      .text(`${isEvent ? payment?.event?.amount?.discount : 0}`, 501.6, invoiceTableTop, {
        width: 60.4,
        align: "center",
      });
    invoiceTableTop = invoiceTableTop + 20;
    doc
      .strokeColor("#aaaaaa")
      .lineWidth(1)
      .rect(50, invoiceTableTop - 5, 512, 20)
      .stroke()
      .text("Total", 60, invoiceTableTop)
      .text(
        `${
          isEvent
            ? payment?.event?.amount?.total
            : payment?.stats?.total || payment?.order?.amount?.total || payment?.amount / 100 || 0
        }`,
        501.6,
        invoiceTableTop,
        {
        width: 60.4,
        align: "center",
        }
      )
      .font("Helvetica");
    invoiceTableTop = invoiceTableTop + 20;
    doc
      .strokeColor("#aaaaaa")
      .lineWidth(1)
      .rect(50, invoiceTableTop - 5, 512, 30)
      .stroke()
      .text("Amount in words", 60, invoiceTableTop)
      .font("Helvetica-Bold")
      .text(
        `${toProperCase(
          convertAmountToWords(
            isEvent
              ? payment?.event?.amount?.total
              : payment?.stats?.total || payment?.order?.amount?.total || payment?.amount / 100 || 0
          )
        )}`,
        60,
        invoiceTableTop + 12
      );
    invoiceTableTop = invoiceTableTop + 40;
    doc
      .font("Helvetica")
      .text(`Amount paid till date: `, 50, invoiceTableTop, { continued: true })
      .font("Helvetica-Bold")
      .text(`${payment?.stats?.received}`);
    invoiceTableTop = invoiceTableTop + 15;
    doc
      .font("Helvetica")
      .text(
        `Amount paid on ${formatDate(payment.createdAt)}: `,
        50,
        invoiceTableTop,
        {
          continued: true,
        }
      )
      .font("Helvetica-Bold")
      .text(`${payment?.amountPaid / 100 || 0}`);
    invoiceTableTop = invoiceTableTop + 15;
    doc
      .font("Helvetica")
      .text(`Balance Amount payable: `, 50, invoiceTableTop, {
        continued: true,
      })
      .font("Helvetica-Bold")
      .text(
        `${
          (isEvent
            ? payment?.event?.amount?.total
            : payment?.stats?.total || payment?.order?.amount?.total || payment?.amount / 100 || 0) -
          (payment?.stats?.received || 0)
        }`
      );
    invoiceTableTop = invoiceTableTop + 15;
    doc
      .font("Helvetica")
      .text(`Payment Type: `, 50, invoiceTableTop, {
        continued: true,
      })
      .font("Helvetica-Bold")
      .text(
        `${toProperCase(
          ["cash", "upi", "bank-transfer"].includes(payment?.paymentMethod)
            ? payment?.paymentMethod?.replace("-", " ")
            : payment?.transactions[0]?.method?.split("_").join(" ") || ""
        )}`
      );
    invoiceTableTop = invoiceTableTop + 15;
    generateHr(doc, invoiceTableTop);
    invoiceTableTop = invoiceTableTop + 30;
    doc.image(
      path.join(__dirname, "../assets/signature.png"),
      doc.page.width - doc.page.margins.right - 80,
      invoiceTableTop,
      {
        width: 80,
      }
    );
    invoiceTableTop = invoiceTableTop + 60;
    doc.font("Helvetica").text(`Authorised Signatory`, 50, invoiceTableTop, {
      align: "right",
    });
  } catch (error) {
    console.log(error);
  }
}
function generateTableRow(doc, y, data) {
  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let columnWidth = [];
  let columnStart = [];
  for (let i = 0; i <= 6; i++) {
    if (i == 0) {
      columnWidth.push(50);
      columnStart.push(doc.page.margins.left);
    } else if (i == 1) {
      columnWidth.push(160);
      columnStart.push(columnStart[i - 1] + columnWidth[i - 1]);
    } else {
      columnWidth.push((availableWidth - 210) / 5);
      columnStart.push(columnStart[i - 1] + columnWidth[i - 1]);
    }
  }
  doc
    .fillColor("#444444")
    .strokeColor("#aaaaaa")
    .lineWidth(1)
    .rect(columnStart[0], y - 5, availableWidth, 20)
    .stroke();
  for (let i = 1; i < columnStart.length; i++) {
    doc
      .moveTo(columnStart[i], y - 5)
      .lineTo(columnStart[i], y + 15)
      .stroke();
  }
  doc
    .fontSize(10)
    .fillColor("#444444")
    .text(data[0], columnStart[0], y, {
      width: columnWidth[0],
      align: "center",
    })
    .text(data[1], columnStart[1] + 5, y)
    .text(data[2], columnStart[2], y, {
      width: columnWidth[2],
      align: "center",
    })
    .text(data[3], columnStart[3], y, {
      width: columnWidth[3],
      align: "center",
    })
    .text(data[4], columnStart[4], y, {
      width: columnWidth[4],
      align: "center",
    })
    .text(data[5], columnStart[5], y, {
      width: columnWidth[5],
      align: "center",
    })
    .text(data[6], columnStart[6], y, {
      width: columnWidth[6],
      align: "center",
    });
}
function formatDate(date) {
  return new Date(date).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function convertAmountToWords(amount) {
  const units = [
    "",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
  ];
  const teens = [
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ];

  // Function to convert a two-digit number to words
  function convertTwoDigits(number) {
    if (number < 10) {
      return units[number];
    } else if (number < 20) {
      return teens[number - 10];
    } else {
      const ten = Math.floor(number / 10);
      const unit = number % 10;
      return tens[ten] + (unit !== 0 ? " " + units[unit] : "");
    }
  }

  // Function to convert a three-digit number to words
  function convertThreeDigits(number) {
    const hundred = Math.floor(number / 100);
    const remaining = number % 100;
    let result = "";
    if (hundred !== 0) {
      result += units[hundred] + " hundred";
    }
    if (remaining !== 0) {
      if (result !== "") {
        result += " and ";
      }
      result += convertTwoDigits(remaining);
    }
    return result;
  }

  // Convert the amount to words
  if (amount === 0) {
    return "zero";
  } else {
    const billion = Math.floor(amount / 1000000000);
    const million = Math.floor((amount % 1000000000) / 1000000);
    const thousand = Math.floor((amount % 1000000) / 1000);
    const remaining = amount % 1000;

    let result = "";

    if (billion !== 0) {
      result += convertThreeDigits(billion) + " billion ";
    }
    if (million !== 0) {
      result += convertThreeDigits(million) + " million ";
    }
    if (thousand !== 0) {
      result += convertThreeDigits(thousand) + " thousand ";
    }
    if (remaining !== 0) {
      result += convertThreeDigits(remaining);
    }

    return result.trim();
  }
}

function formatDateString(dateString) {
  let date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return day + month + year;
}

function generateHr(doc, y) {
  doc
    .strokeColor("#aaaaaa")
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(612 - 50, y)
    .stroke();
}

function formatCurrency(amount) {
  return amount
    ? amount.toLocaleString("en-IN", {
        maximumFractionDigits: 2,
        style: "currency",
        currency: "INR",
      })
    : "";
}
function createInvoice(payment, res) {
  try {
    let doc = new PDFDocument({ size: "A4", margin: 50 });
    let chunks = [];
    let result;

    doc.on("data", (chunk) => {
      chunks.push(chunk);
    });

    generateHeader(doc);
    generateCustomerInformation(doc, payment);
    generateInvoiceTable(doc, payment);
    generateFooter(doc);

    doc.on("end", () => {
      result = Buffer.concat(chunks);
      const contentLength = result.length;
      res.setHeader("Content-Length", contentLength);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="invoice-${formatDateString(payment.createdAt)}.pdf"`
      );
      res.status(200).end(result);
    });
    doc.on("error", (err) => {
      console.error("Error generating PDF:", err);
      res.status(500).send("Error generating PDF");
    });
    doc.end();
  } catch (error) {
    console.error("Error:", error);
    res.status(500).send("Error");
  }
}

module.exports = {
  createInvoice,
};
