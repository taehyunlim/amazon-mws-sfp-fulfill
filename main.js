'use strict';

// API Credential
const config = require('./config.js');
const api_keys = {
  "aws_developer_id": config.aws_developer_id,
  "aws_access_key_id": config.aws_access_key_id,
  "aws_secret_access_key": config.aws_secret_access_key,
  "mws_seller_id": config.mws_seller_id
}

// Dependencies
var fs = require('fs');
var path = require('path');
var amazonMws = require('amazon-mws')(api_keys.aws_access_key_id,api_keys.aws_secret_access_key);
var XLSX = require('xlsx');
var ExcelWriter = require('node-excel-stream').ExcelWriter;
var moment = require('moment');
var inquirer = require('inquirer');
var gunzip = require('gunzip-file');
var Table = require('cli-table');
var utils = require('./utils');
var Bottleneck = require("bottleneck");
var PDFMerge = require('pdf-merge');
// https://www.pdflabs.com/tools/pdftk-the-pdf-toolkit/

// Throttling: Never more than 1 request running at a time; Wait at least 500ms between each request.
var limiter = new Bottleneck({
  maxConcurrent: 3,
  minTime: 500
});

// Global Variables
// var dateTime = new Date('2018-02-11'); // Required for certain MWS API operations
var fileNameDate = process.argv[2];
var dateString = moment().format("MM.DD.YY");
var dateTimeString = moment().format("MM.DD.YY__HH.mm");
var lineItemCounter = 0;
var whCode = '' // 'CHS1' or 'SL'
var dimsFeedDir = './application/sfp_dims.xlsx';
var orderFeedDir = './application/INPUT/' + fileNameDate + '.xlsx';
var subsFeedDir = './application/INPUT/' + fileNameDate + '_SUBS.xlsx';
var releaseFeedDir = ''; // To be dynamically created
var outputTrackingDir = './application/OUTPUT/' + fileNameDate +'/';
var ordersArray = [];
var subsArray = [];

// Placeholder for Release Feed file input
// Note: Dimensions will only accept integers
var dimsArray = [];

// Amazon Order Input Feed
if (utils.fsExistsSync(orderFeedDir)) {
  var workbookOrders = XLSX.readFile(orderFeedDir);
  ordersArray = XLSX.utils.sheet_to_json(workbookOrders.Sheets[workbookOrders.SheetNames[0]]);
} else {
  console.log("[MESSAGE] The order feed does not exist: " + orderFeedDir);
  return;
}

// Begin here with the first prompt: WH Location
inquirer.prompt([{
  type: 'list',
  message: 'Select WH Location:',
  name: 'wh',
  choices:[{name: 'CHS1'}, {name: 'SL'}]
}])
.then(answers => {
  switch (answers.wh) {
    case 'CHS1': whCode = 'CHS1';
      break;
    case 'SL': whCode = 'SL';
      break;
  }
  releaseFeedDir = `./application/INPUT/${fileNameDate}_REL_${whCode}.xlsx`
  var workbook = XLSX.readFile(releaseFeedDir);
  dimsArray = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  stepZero();
})

// STEP ZERO: Confirm Subs input file data
function stepZero() {
  // Check if Subs Input feed is provided
  if (!utils.fsExistsSync(subsFeedDir)) {
    // CASE 1/2: Subs Input Feed is not provided - Confirm
    console.log("[MESSAGE] No Subs Feed file is proivided. ")
    inquirer.prompt([{
      type: 'list',
      message: 'Select Y to Continue; Otherwise select N to exit:',
      name: 'input_subs',
      choices: [{name: 'Y'}, {name: 'N'}]
    }])
    .then(answers => {
      if (answers.input_subs === "Y") {
        console.log("[MESSAGE] Proceeding without Subs Feed...")
        stepOne();
      } else { process.exit() }
    });
  } else {
    // CASE 2/2: Subs Input Feed is provided
    var workbookSubs = XLSX.readFile(subsFeedDir);
    subsArray = XLSX.utils.sheet_to_json(workbookSubs.Sheets[workbookSubs.SheetNames[0]]);
    var table = new Table({'head': ['origin-sku', 'sub-sku']});
    subsArray.forEach(e => {
      var originSKU = e.origin,
          subSKU = e.sub
      table.push([originSKU, subSKU]);
    })
    console.log("[MESSAGE] Subs Feed:");
    console.log(table.toString(), "\n");
    // Confirm if the subs feed is acceptable
    console.log("[MESSAGE] Please confirm if the Subs Feed is acceptable.")

    inquirer.prompt([{
      type: 'list',
      message: 'Select Y to Continue; Otherwise select N to exit:',
      name: 'input_subs',
      choices: [{name: 'Y'}, {name: 'N'}]
    }])
    .then(answers => {
      if (answers.input_subs === "Y") {
        stepOne();
      }
    }); // END OF Inquirer
  }
}

// STEP ONE: Find the cheapest rate for all shipments
function stepOne() {
  // Daily Output Directory - Create directory if DNE
  if (!fs.existsSync(outputTrackingDir)) {
    fs.mkdirSync(outputTrackingDir);
  }

  // Process Orders
  var shpReqDetArray = orderShipmentDetails(ordersArray);
  console.log(`[MESSAGE] Total # of shipments to process in ${whCode}: ${shpReqDetArray.length}`);

  // Promise Array
  var shippingServicesArray = [];

  // Loop through each Shipment Request Detail element
  for (var i = 0; i < shpReqDetArray.length; i++) {
    //getEligibleShippingServices to return a promise
    shippingServicesArray.push(limiter.schedule(getEligibleShippingServices, shpReqDetArray[i]));
  }

  // Perform a promise callback
  Promise.all(shippingServicesArray)
  .then(result => {
    // Prepare stream object to write to excel
    let ratesToExcel = new ExcelWriter({
      sheets: [{
        name: `${dateTimeString}`,
        key: `shipmentRates_${dateTimeString}`,
        headers: [
          {name: 'whCode', key: 'whcode'},
          {name: 'lineNum', key: 'lineItemCounter'},
          {name: 'AmazonOrderId', key: 'AmazonOrderId'},
          {name: 'subSKU', key: 'subSKU'},
          {name: 'carrierName', key: 'carrierName'},
          {name: 'shippingServiceId', key: 'shippingServiceId'},
          {name: 'rate', key: 'rate'}
        ]
      }]
    })
    let shipRatesArray = [];

    // Prepare table object to display
    let table = new Table({'head': ['lineNo', 'AmazonOrderId', 'Sub SKU', 'carrierName', 'shippingServiceId', 'rate']});
    // Loop through the shipments
    for (var i = 0; i < result.length; i++) {
      let shippingRequest = result[i];
      // console.log(shippingRequest.AmazonOrderId, shippingRequest.eligibleShippingService)
      let lineItemCounter = shippingRequest.lineItemCounter,
          AmazonOrderId = shippingRequest.AmazonOrderId,
          subSKU = shippingRequest.subSKU,
          carrierName = shippingRequest.eligibleShippingService.carrierName,
          shippingServiceId = shippingRequest.eligibleShippingService.shippingServiceId,
          rate = shippingRequest.eligibleShippingService.rate;
      let shipRates = [lineItemCounter, AmazonOrderId, subSKU, carrierName, shippingServiceId, rate];
      table.push(shipRates);
      shipRatesArray.push(shipRates);
    }

    // Create promise objects out of shipRatesArray
    let ratesPromises = shipRatesArray.map((e) => {
      let excelInput = {
        whcode: whCode,
        lineItemCounter: e[0],
        AmazonOrderId: e[1],
        subSKU: e[2],
        carrierName: e[3],
        shippingServiceId: e[4],
        rate: e[5]
      };
      ratesToExcel.addData(`shipmentRates_${dateTimeString}`, excelInput);
    });


    // Show eligible shipping service for the lowest rate
    console.log("[MESSAGE] Eligible Shipping Service (w/ Lowest Rates):");
    console.log(table.toString(), "\n");
    // Confirm if the subs feed is acceptable
    console.log("[MESSAGE] Please confirm if the rates are acceptable.")

    inquirer.prompt([{type: 'list', message: 'Select Y to Continue; Otherwise select N to exit:', name: 'input_subs', choices: [{name: 'Y'}, {name: 'N'}]}]).then(answers => {
      if (answers.input_subs === "Y") {
        // Continue to CreateShipment operation
        stepTwo(result)
        // Crate excel report that contains the rate per shipment
        Promise.all(ratesPromises)
        .then(()=> { return ratesToExcel.save(); })
        .then((stream) => { stream.pipe(fs.createWriteStream(outputTrackingDir + `${dateString}__${whCode}__rates.xlsx`)); })
      }
    });

  })
  .catch(error => {
    console.log(error);
  })

}

// STEP TWO: Purchase labels based on the results from STEP ONE
function stepTwo(shipReqDetSrv) {
  // Shipment Output Directory - Create directory if DNE
  let labelDir = outputTrackingDir + `${dateString}__${whCode}__gzip`
  if (!fs.existsSync(labelDir)) {
    fs.mkdirSync(labelDir);
  }

  // Promise Array
  var createdShipmentArray = [];

  // Loop through each Shipment Request Detail element with Eligible Shipping Service
  for (var i = 0; i < shipReqDetSrv.length; i++) {
    //getEligibleShippingServices to return a promise
    if (shipReqDetSrv[i].eligibleShippingService.rate !== 'N/A') {
      createdShipmentArray.push(limiter.schedule(createShipment, shipReqDetSrv[i]));
    }
  }

  // Perform a promise callback
  Promise.all(createdShipmentArray.map(e => e.catch((error) => error)))
  .then(result => {
    // Prepare stream object to write to excel
    let trackingToExcel = new ExcelWriter({
      sheets: [{
        name: `${dateTimeString}`,
        key: `shipmentTracking_${dateTimeString}`,
        headers: [
          {name: 'wh-code', key: 'whcode'},
          {name: 'line-no', key: 'lineNum'},
          {name: 'order-id', key: 'orderId'},
          {name: 'order-item-id', key: 'orderItemId'},
          {name: 'shipment-id', key: 'shipmentId'},
          {name: 'origin-sku', key: 'originSKU'},
          {name: 'sub-sku', key: 'subSKU'},
          {name: 'trackingNumber', key: 'tracking'}
        ]
      }]
    })
    let shipTrackingsArray = [];
    // order-id	order-item-id	shipment-id	origin-sku	released-sku	Tracking

    for (var i = 0; i < result.length; i++) {
      let shipmentResponse = result[i];
      shipTrackingsArray.push(shipmentResponse)
    }

    // Create promise objects out of shipTrackingsArray
    let trackingPromises = shipTrackingsArray.map((data) => {
      let excelInput = {
        whcode: whCode,
        lineNum: data.orderItem.lineItemCounter,
        orderId: data.orderItem.AmazonOrderId,
        orderItemId: data.orderItem.OrderItemId,
        shipmentId: data.shipmentId,
        originSKU: data.orderItem.originSKU,
        subSKU: data.orderItem.subSKU,
        tracking: data.tracking
      };
      trackingToExcel.addData(`shipmentTracking_${dateTimeString}`, excelInput);
    });

    // Crate excel report that contains tracing numbers
    Promise.all(trackingPromises)
    .then(()=> { return trackingToExcel.save(); })
    .then((stream) => { stream.pipe(fs.createWriteStream(outputTrackingDir + `${dateString}__${whCode}__tracking.xlsx`)); })
  })
  .then(() => {
    // Merge the generated files
    let dir = outputTrackingDir + `${dateString}__${whCode}__pdf`
    fs.readdir(dir, function(err, filepath) {
        let files = filepath.map(e => {
          return dir + '/' + e;
        })
        PDFMerge(files)
        .then((buffer) => {
          fs.writeFile(dir + `/${dateString}__${whCode}__merged.pdf`, buffer, function(err) {
            if (err) throw err;
            console.log('merged');
          })
        })
    });
  })
}

// Translate order input feed to shipment info
function orderShipmentDetails(array) {
  var shipRequestDetailsArray = []
  for (var i = 0; i < array.length; i++) {
    var orderId = array[i]["order-id"];
    function released(e){
      return (e['PO Number'] === orderId);
    }
    if (dimsArray.find(released)) {
      var orderSKU = array[i]["system-sku"];
      var subSKU = utils.findSubSKU(orderSKU, subsArray);
      var dimsWt = utils.findReleaseDimsBySku(subSKU, dimsArray);
      var orderItemQty = array[i]["quantity-purchased"];
      var orderItemId = array[i]["order-item-id"];
      if (orderItemId.length !== 14) {
        switch (orderItemId.length) {
          case 11:
            orderItemId = "000" + orderItemId;
            break;
          case 12:
            orderItemId = "00" + orderItemId;
            break;
          case 13:
            orderItemId = "0" + orderItemId;
            break;
        }
      }
      // console.log(orderItemId);
      for (var j = 0; j < orderItemQty; j++) {
        lineItemCounter++;
        var order = {
          "orderId": array[i]["order-id"],
          "orderItemId": orderItemId,
          "orderItemLineNo": j+1, // 1-based index for item line number per qty
          "latestShipDate": array[i]["latest-ship-date"],
          "orderSKU": orderSKU,
          "subSKU": subSKU,
          "dimL": dimsWt.dimL,
          "dimW": dimsWt.dimW,
          "dimH": dimsWt.dimH,
          "dimUnit": dimsWt.dimUnit,
          "wValue": dimsWt.wValue,
          "wUnit": dimsWt.wUnit,
          "lineItemCounter": lineItemCounter
        }
        var shpReqDet = new ShipmentRequestDetails(order);
        shipRequestDetailsArray.push(shpReqDet);
      }
    }
  }
  return shipRequestDetailsArray;
}

// Create ShipmentRequestDetails object for API
function ShipmentRequestDetails(order) {
  this.AmazonOrderId = order.orderId;
  this.PackageDimensions = {
    "Length": order.dimL,
    "Width": order.dimW,
    "Height": order.dimH,
    "Unit": order.dimUnit
  };
  this.Weight = {
    "Value": order.wValue,
    "Unit": order.wUnit
  };
  if (whCode === 'SL') {
    this.ShipFromAddress = {
      "Name": "Zinus, Inc",
      "AddressLine1": "1951A Fairway Drive",
      "AddressLine2": "",
      "City": "San Leandro",
      "StateOrProvinceCode": "CA",
      "PostalCode": "94577",
      "CountryCode": "US",
      "Email": "customerservice@zinusinc.com",
      "Phone": "8006131225"
    };
  } else if (whCode === 'CHS1') {
    this.ShipFromAddress = {
      "Name": "Zinus, Inc",
      "AddressLine1": "1125 Newton Way",
      "AddressLine2": "",
      "City": "Summerville",
      "StateOrProvinceCode": "SC",
      "PostalCode": "29483",
      "CountryCode": "US",
      "Email": "customerservice@zinusinc.com",
      "Phone": "8006131225"
    };
  }
  this.ShippingServiceOptions = {
    "DeliveryExperience": "DeliveryConfirmationWithoutSignature",
    "CarrierWillPickUp": "false"
  };
  this.ItemList = {
    "Item": {
      1: {
        "OrderItemId": order.orderItemId,
        "orderItemLineNo": order.orderItemLineNo
      }
    }
  };
  this.originSKU = order.orderSKU;
  this.subSKU = order.subSKU;
  this.lineItemCounter = order.lineItemCounter;
  this.eligibleShippingService = {
    "carrierName": '',
    "shippingServiceId": '',
    "rate": ''
  };
}

// Run API calls to get shipping services and choose the cheapest rate
function getEligibleShippingServices(shipReqDet) {
  var orderItem = {
    "AmazonOrderId": shipReqDet.AmazonOrderId,
    "OrderItemId": shipReqDet.ItemList.Item[1].OrderItemId,
    "orderItemLineNo": shipReqDet.ItemList.Item[1].orderItemLineNo,
    "lineItemCounter": shipReqDet.lineItemCounter
  }

  // Amazon MWS API Operation: GetEligibleShippingServices
  return new Promise(function(resolve, reject) {
    amazonMws.merchantFulfillment.search({
      'Version': '2015-06-01',
      'Action': 'GetEligibleShippingServices',
      'SellerId': api_keys.mws_seller_id,
      'ShipmentRequestDetails.AmazonOrderId': shipReqDet.AmazonOrderId,
      'ShipmentRequestDetails.PackageDimensions.Length': shipReqDet.PackageDimensions.Length,
      'ShipmentRequestDetails.PackageDimensions.Width': shipReqDet.PackageDimensions.Width,
      'ShipmentRequestDetails.PackageDimensions.Height': shipReqDet.PackageDimensions.Height,
      'ShipmentRequestDetails.PackageDimensions.Unit': shipReqDet.PackageDimensions.Unit,
      'ShipmentRequestDetails.Weight.Value': shipReqDet.Weight.Value,
      'ShipmentRequestDetails.Weight.Unit': shipReqDet.Weight.Unit,
      'ShipmentRequestDetails.ShipFromAddress.Name': shipReqDet.ShipFromAddress.Name,
      'ShipmentRequestDetails.ShipFromAddress.AddressLine1': shipReqDet.ShipFromAddress.AddressLine1,
      'ShipmentRequestDetails.ShipFromAddress.City': shipReqDet.ShipFromAddress.City,
      'ShipmentRequestDetails.ShipFromAddress.StateOrProvinceCode': shipReqDet.ShipFromAddress.StateOrProvinceCode,
      'ShipmentRequestDetails.ShipFromAddress.PostalCode': shipReqDet.ShipFromAddress.PostalCode,
      'ShipmentRequestDetails.ShipFromAddress.CountryCode': shipReqDet.ShipFromAddress.CountryCode,
      'ShipmentRequestDetails.ShipFromAddress.Email': shipReqDet.ShipFromAddress.Email,
      'ShipmentRequestDetails.ShipFromAddress.Phone': shipReqDet.ShipFromAddress.Phone,
      'ShipmentRequestDetails.ShippingServiceOptions.DeliveryExperience': shipReqDet.ShippingServiceOptions.DeliveryExperience,
      'ShipmentRequestDetails.ShippingServiceOptions.CarrierWillPickUp': shipReqDet.ShippingServiceOptions.CarrierWillPickUp,
      'ShipmentRequestDetails.ItemList.Item.1.OrderItemId': shipReqDet.ItemList.Item[1].OrderItemId,
      'ShipmentRequestDetails.ItemList.Item.1.Quantity': "1" // Hardcoded: 1
      }, function (error, response) {
        console.log(`[MESSAGE][${shipReqDet.lineItemCounter}] Processing Shipment Request Details for Order ID: ${shipReqDet.AmazonOrderId}`);

        if (error) {
          if (error.Code === 'ResourceNotFound') {
            shipReqDet.eligibleShippingService.carrierName = 'N/A'
            shipReqDet.eligibleShippingService.shippingServiceId = 'N/A'
            shipReqDet.eligibleShippingService.rate = 'N/A'
            console.log(`[MESSAGE][${shipReqDet.lineItemCounter}] Order Id Not Found - Check if cancelled: ${orderItem.AmazonOrderId}`)
            resolve(shipReqDet);
          } else {
            console.log('error ', error);
            reject(error);
          }
        }

        if (response) {
          // console.log('response', response);
          // Loop through the result
          var shippingServiceOptionsArray = [];
          var shippingServiceResponse = response.ShippingServiceList.ShippingService;
          // Handle response
          if ( shippingServiceResponse.length > 0) {
            for (var i = 0; i < shippingServiceResponse.length; i++) {
              var data = shippingServiceResponse[i];
              // console.log(data);
              var shippingService = {
                "CarrierName": data.CarrierName,
                "ShippingServiceId": data.ShippingServiceId,
                "Rate": data.Rate.Amount
              }
              // Filter by FedEx only
              if (shippingService.CarrierName === 'FEDEX') {
                shippingServiceOptionsArray.push(shippingService);
              }
            }
            // Find the cheapest rate service available
            var shippingServiceSelected = utils.sortByKeyValue('Rate', shippingServiceOptionsArray)[0];
            // console.log(shippingServiceSelected);
            if (shippingServiceSelected) {
              shipReqDet.eligibleShippingService.carrierName = shippingServiceSelected.CarrierName;
              shipReqDet.eligibleShippingService.shippingServiceId = shippingServiceSelected.ShippingServiceId;
              shipReqDet.eligibleShippingService.rate = shippingServiceSelected.Rate;
              resolve(shipReqDet);
            } else {
              resolve(shipReqDet);
            }
          } else {
            console.log(`[MESSAGE][${shipReqDet.lineItemCounter}] Shipping service unavailable for an item in Order Id: ${orderItem.AmazonOrderId}`);
            resolve(shipReqDet);
          }

        } // END OF reponse
      }
    ) // END OF MWS API
  }) // END OF Promise

}

// Run API calls to purchase shipments and retrieve/store label in pdf
function createShipment(shipReqDet) {
  var orderItem = {
    "AmazonOrderId": shipReqDet.AmazonOrderId,
    "OrderItemId": shipReqDet.ItemList.Item[1].OrderItemId,
    "orderItemLineNo": shipReqDet.ItemList.Item[1].orderItemLineNo,
    "lineItemCounter": shipReqDet.lineItemCounter,
    "originSKU": shipReqDet.originSKU,
    "subSKU": shipReqDet.subSKU
  }
  return new Promise(function(resolve, reject) {
    amazonMws.merchantFulfillment.create({
      'Version': '2015-06-01',
      'Action': 'CreateShipment',
      'SellerId': api_keys.mws_seller_id,
      'ShippingServiceId': shipReqDet.eligibleShippingService.shippingServiceId,
      'ShipmentRequestDetails.LabelCustomization.StandardIdForLabel': 'AmazonOrderId',
      'ShipmentRequestDetails.AmazonOrderId': shipReqDet.AmazonOrderId,
      'ShipmentRequestDetails.PackageDimensions.Length': shipReqDet.PackageDimensions.Length,
      'ShipmentRequestDetails.PackageDimensions.Width': shipReqDet.PackageDimensions.Width,
      'ShipmentRequestDetails.PackageDimensions.Height': shipReqDet.PackageDimensions.Height,
      'ShipmentRequestDetails.PackageDimensions.Unit': shipReqDet.PackageDimensions.Unit,
      'ShipmentRequestDetails.Weight.Value': shipReqDet.Weight.Value,
      'ShipmentRequestDetails.Weight.Unit': shipReqDet.Weight.Unit,
      'ShipmentRequestDetails.ShipFromAddress.Name': shipReqDet.ShipFromAddress.Name,
      'ShipmentRequestDetails.ShipFromAddress.AddressLine1': shipReqDet.ShipFromAddress.AddressLine1,
      'ShipmentRequestDetails.ShipFromAddress.AddressLine2': shipReqDet.AmazonOrderId,
      'ShipmentRequestDetails.ShipFromAddress.AddressLine3': shipReqDet.subSKU,
      'ShipmentRequestDetails.ShipFromAddress.City': shipReqDet.ShipFromAddress.City,
      'ShipmentRequestDetails.ShipFromAddress.StateOrProvinceCode': shipReqDet.ShipFromAddress.StateOrProvinceCode,
      'ShipmentRequestDetails.ShipFromAddress.PostalCode': shipReqDet.ShipFromAddress.PostalCode,
      'ShipmentRequestDetails.ShipFromAddress.CountryCode': shipReqDet.ShipFromAddress.CountryCode,
      'ShipmentRequestDetails.ShipFromAddress.Email': shipReqDet.ShipFromAddress.Email,
      'ShipmentRequestDetails.ShipFromAddress.Phone': shipReqDet.ShipFromAddress.Phone,
      'ShipmentRequestDetails.ShippingServiceOptions.DeliveryExperience': shipReqDet.ShippingServiceOptions.DeliveryExperience,
      'ShipmentRequestDetails.ShippingServiceOptions.CarrierWillPickUp': shipReqDet.ShippingServiceOptions.CarrierWillPickUp,
      // 'ShipmentRequestDetails.ShippingServiceOptions.LabelFormat': 'PDF',
      'ShipmentRequestDetails.ItemList.Item.1.OrderItemId': shipReqDet.ItemList.Item[1].OrderItemId,
      'ShipmentRequestDetails.ItemList.Item.1.Quantity': "1" // HARDCODED: 1
      }, function (error, response) {
        // Handle error case
        if (error) {
          if (error.Code === 'ShipmentAlreadyExists') {
            // Handle error case when ShipmentAlreadyExists
            let shipmentIdString = error.Message;
            // shipmentIdString may come in multiples, comma seperated;
            let shipmentIdArray = shipmentIdString.split(",");
            let getShipmentPromiseArray = [];
            // getShipment callback to retrieve existing label info
            shipmentIdArray.map(e => {
              getShipmentPromiseArray.push(getShipment(e));
            });
            Promise.all(getShipmentPromiseArray)
            .then(data => {
              let trackingArray = data.join(",");
              let shipmentResponse = {
                'tracking': trackingArray, // From getShipment Promise
                'orderItem': orderItem,
                'shipmentId': shipmentIdString,
              }
              resolve(shipmentResponse);
            })
            .catch(() => {
              let shipmentResponse = {
                'tracking': '',
                'orderItem': orderItem,
                'shipmentId': shipmentIdString,
              }
              resolve(shipmentResponse);
            })
          } else {
            // For all other error types returned that is not "Shipment Already Exists"
            console.log(error);
            let shipmentResponse = {
              'tracking': '',
              'orderItem': orderItem,
              'shipmentId': '',
            }
            reject(shipmentResponse);
          }
        }
        // Save label if response contains Shipment element
        if (response) {
          console.log(`[MESSAGE][${shipReqDet.lineItemCounter}] Shipment Label Purchased for: ${shipReqDet.AmazonOrderId} || Tracking Number: ${response.Shipment.TrackingId}`);

          // Set temporary variables to store response elements
          let shipmentResponse = {
            'tracking': response.Shipment.TrackingId,
            'orderItem': orderItem,
            'shipmentId': response.Shipment.ShipmentId
          }

          // Prepare data to fulfill the promise and write pdf file
          let file = response.Shipment.Label.FileContents.Contents;
          let fileName = `${shipReqDet.lineItemCounter}__${dateTimeString}.pdf.gz`
          let fileNamePdf = `${shipReqDet.lineItemCounter}__${dateTimeString}.pdf`

          // Specify directory to store labels
          let labelDir = outputTrackingDir + `${dateString}__${whCode}__gzip`
          let labelPdfDir = outputTrackingDir + `${dateString}__${whCode}__pdf`
          if (!fs.existsSync(labelPdfDir)) {
            fs.mkdirSync(labelPdfDir);
          }

          // Create a promise for gzip write
          let promiseGzip = new Promise((resolve, reject) => {
            fs.writeFile(labelDir + '/' + fileName, file, {encoding: 'base64'}, function(err) {
              if (err) throw err;
              resolve();
            });
          });

          // Resolve promise with a gunzip method
          promiseGzip.then(() => {
            gunzip(labelDir + '/' + fileName, labelPdfDir + '/' + fileNamePdf, ()=> {
              console.log(`[MESSAGE][${shipReqDet.lineItemCounter}] pdf file created.`);
              // Resolve parent promise
              resolve(shipmentResponse);
            });
          })

        }
        // END OF response
      }
    ) // END OF MWS API
  }); // END OF Promise
}

// Retrieve shipment info using ShipmentId
function getShipment(shipmentId) {
  return new Promise(function(resolve, reject) {
    amazonMws.merchantFulfillment.search({
      'Version': '2015-06-01',
      'Action': 'GetShipment',
      'SellerId': api_keys.mws_seller_id,
      // TEST SHIPMENT ID
      'ShipmentId':shipmentId
      }, function (error, response) {
        if (error) {
            reject(error);
        }
        // Prepare data to fulfill the promise and write pdf file
        let file = response.Shipment.Label.FileContents.Contents;
        let fileName = `${response.Shipment.AmazonOrderId}__${response.Shipment.TrackingId}__${dateTimeString}.pdf.gz`
        let fileNamePdf = `${response.Shipment.AmazonOrderId}__${response.Shipment.TrackingId}__${dateTimeString}.pdf`
        let tracking = response.Shipment.TrackingId;

        // Specify directory to store labels
        let labelDir = outputTrackingDir + `${dateString}__${whCode}__gzip`
        let labelPdfDir = outputTrackingDir + `${dateString}__${whCode}__pdf`
        if (!fs.existsSync(labelPdfDir)) {
          fs.mkdirSync(labelPdfDir);
        }

        // Create a promise for gzip write
        let promiseGzip = new Promise((resolve, reject) => {
          fs.writeFile(labelDir + '/' + fileName, file, {encoding: 'base64'}, function(err) {
            if (err) throw err;
            resolve();
          });
        });

        // Resolve promise with a gunzip method
        promiseGzip.then(() => {
          gunzip(labelDir + '/' + fileName, labelPdfDir + '/' + fileNamePdf, ()=> {
            console.log(`[MESSAGE] pdf file created.`);
            // Resolve parent promise
            resolve(tracking)
          });
        })

      }
    )
  });
}

String.prototype.replaceAll = function(search, replacement) {
    var target = this;
    return target.split(search).join(replacement);
};
