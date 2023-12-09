sleep 2
webservice --mem 1Gi --backend=kubernetes node18 stop > log.txt
sleep 15
webservice --mem 1Gi --backend=kubernetes node18 start > log.txt
sleep 15
webservice --mem 1Gi --backend=kubernetes node18 stop > log.txt
sleep 15
webservice --mem 1Gi --backend=kubernetes node18 start > log.txt
